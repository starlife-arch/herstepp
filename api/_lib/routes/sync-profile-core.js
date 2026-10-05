// Core logic of POST /api/auth/sync-profile, kept free of any Vercel-only
// imports so scripts/test-sync-profile.mjs can exercise every branch against
// the in-memory fake Firestore. sync-profile.js is the thin HTTP wrapper.
// firebase-admin's FieldValue works offline (plain sentinel objects), and
// notify.js only needs injectable deps for delivery — both are safe to import.
import { FieldValue } from 'firebase-admin/firestore';
import { clientError } from '../http.js';
import { normalizeKenyanPhone } from '../phone.js';
import { queueWelcomeEmail } from '../notify.js';

function stringValue(value) {
  return typeof value === 'string' ? value.trim() : undefined;
}

// Google accounts have a verified email but no phone on our side — they may
// create their profile WITHOUT a Kenyan number (phoneNumber ''). Every other
// provider (i.e. password) still needs a valid phone for a NEW profile.
export function isGoogleProvider(user) {
  const provider = user?.signInProvider || user?.firebase?.sign_in_provider || '';
  return provider === 'google.com';
}

export async function syncProfileCore(deps, user, body) {
  const { db, waitUntil, sendTelegramMessage } = deps;
  const deliverQueuedEmailInline = deps.deliverQueuedEmailInline ?? (() => Promise.resolve());
  const userRef = db.collection('users').doc(user.uid);
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
    if (!phoneNumber && !isGoogleProvider(user)) {
      throw clientError('A valid phone number is required.');
    }
    firstSignUp = true;

    // Welcome email queued in the SAME transaction that creates users/{uid} —
    // deterministic key <uid>-WELCOME means a replayed sync never double-sends.
    await db.runTransaction(async tx => {
      const fresh = await tx.get(userRef);
      if (fresh.exists) { firstSignUp = false; return; }
      tx.set(userRef, {
        uid: user.uid,
        email: user.email || '',
        displayName: stringValue(body.displayName) || user.displayName || '',
        phoneNumber: phoneNumber || '',
        deliveryDetails: body.deliveryDetails ?? null,
        marketingConsent: false,
        // Server-written mirror of the Auth token's email_verified claim — the
        // dashboard banner and Checkout read it from GET /api/dashboard.
        // Google accounts arrive verified; password sign-ups must confirm the
        // 6-digit code (POST /api/auth/verify/confirm sets this to true).
        emailVerified: user.email_verified === true || isGoogleProvider(user),
        role: 'CUSTOMER',
        createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      try {
        queueWelcomeEmail(tx, db, {
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
      waitUntil(deliverQueuedEmailInline(db, `${user.uid}-WELCOME`).catch(() => {}));
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

  return { ok: true };
}
