import { FieldValue } from 'firebase-admin/firestore';
import { adminDb, requireUser } from '../firebase-admin.js';
import { clientError, methodNotAllowed } from '../http.js';
import { normalizeKenyanPhone } from '../phone.js';

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

  if (!snapshot.exists) {
    if (!phoneNumber) {
      throw clientError('A valid phone number is required.');
    }

    await userRef.set({
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
