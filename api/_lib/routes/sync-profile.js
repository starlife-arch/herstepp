import { FieldValue } from 'firebase-admin/firestore';
import { waitUntil } from '@vercel/functions';
import { adminDb, requireUser } from '../firebase-admin.js';
import { clientError, methodNotAllowed } from '../http.js';
import { normalizeKenyanPhone } from '../phone.js';
import { sendTelegramMessage } from '../telegram.js';
import { deliverQueuedEmailInline } from '../email-service.js';
import { queueWelcomeEmail } from '../notify.js';

function stringValue(value) {
  return typeof value === 'string' ? value.trim() : undefined;
}

export default async function syncProfile(req, res) {
  if (req.method !== 'POST') {
    return methodNotAllowed(res, 'POST');
  }

  const user = await requireUser(req);
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const userRef = adminDb.collection('users').doc(user.uid);
  const snapshot = await userRef.get();
  let phoneNumber;
  if (body.phoneNumber !== undefined) {
    try {
      phoneNumber = normalizeKenyanPhone(body.phoneNumber);
    } catch (error) {
      if (!snapshot.exists) throw clientError('A valid phone number is required.');
      throw error;
    }
  }

  let firstSignUp = false;
  if (!snapshot.exists) {
    if (!phoneNumber) {
      throw clientError('A valid phone number is required.');
    }
    firstSignUp = true;

    // Welcome email queued in the SAME transaction that creates users/{uid} —
    // deterministic key <uid>-WELCOME means a replayed sync never double-sends.
    await adminDb.runTransaction(async tx => {
      const fresh = await tx.get(userRef);
      if (fresh.exists) { firstSignUp = false; return; }
      tx.set(userRef, {
        uid: user.uid,
        email: user.email || '',
        displayName: stringValue(body.displayName) || user.displayName || '',
        phoneNumber,
        deliveryDetails: body.deliveryDetails ?? null,
        marketingConsent: false,
        role: 'CUSTOMER',
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      try {
        queueWelcomeEmail(tx, adminDb, {
          uid: user.uid,
          email: user.email || '',
          displayName: stringValue(body.displayName) || user.displayName || '',
        });
      } catch (error) {
        // Notification failure must NEVER break sign-up.
        console.error('[sync-profile] welcome email queue failed:', error?.message || error);
      }
    });

    if (firstSignUp) {
      // Admin Telegram ping — best-effort, kept alive via waitUntil.
      const who = stringValue(body.displayName) || user.displayName || 'New customer';
      const contact = user.email || phoneNumber || '';
      waitUntil(sendTelegramMessage(`New customer sign-up: ${who} · ${contact}`).catch(() => false));
      waitUntil(deliverQueuedEmailInline(adminDb, `${user.uid}-WELCOME`).catch(() => {}));
    }
  } else {
    const update = {
      email: user.email || '',
      updatedAt: FieldValue.serverTimestamp(),
    };

    if (body.displayName !== undefined) update.displayName = stringValue(body.displayName) || '';
    if (phoneNumber !== undefined) update.phoneNumber = phoneNumber;
    if (body.deliveryDetails !== undefined) update.deliveryDetails = body.deliveryDetails;
    if (typeof body.marketingConsent === 'boolean') update.marketingConsent = body.marketingConsent;

    await userRef.update(update);
  }

  return res.status(200).json({ ok: true });
}
