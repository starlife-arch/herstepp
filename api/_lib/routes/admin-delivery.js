// GET/PATCH /api/admin/delivery. The admin UI never sees the legacy
// outsideJuja rate, but PATCH preserves it exactly through the shared validator.
import { FieldValue } from 'firebase-admin/firestore';
import { adminDb, requireAdmin } from '../firebase-admin.js';
import { clientError, methodNotAllowed } from '../http.js';
import { normalizeDelivery, validateDelivery } from '../delivery.js';

export default async function delivery(req, res) {
  const admin = await requireAdmin(req);
  if (req.method !== 'GET' && req.method !== 'PATCH') return methodNotAllowed(res, ['GET', 'PATCH']);

  const checkoutRef = adminDb.doc('settings/checkout');
  const snapshot = await checkoutRef.get();
  const previous = normalizeDelivery(snapshot.exists ? snapshot.data() || {} : {});
  if (req.method === 'GET') return res.status(200).json(previous);

  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const requestedRates = body.deliveryRates && typeof body.deliveryRates === 'object' ? body.deliveryRates : {};
  let next;
  try {
    next = validateDelivery({
      ...body,
      deliveryRates: { ...requestedRates, outsideJuja: previous.deliveryRates.outsideJuja },
    });
  } catch (error) {
    throw clientError(error instanceof Error ? error.message : 'Delivery settings are invalid.');
  }
  const user = await adminDb.collection('users').doc(admin.uid).get();
  const adminName = user.data()?.displayName || admin.name || admin.email || '';
  await adminDb.runTransaction(async tx => {
    tx.set(checkoutRef, next, { merge: true });
    tx.set(adminDb.collection('auditLogs').doc(), {
      adminId: admin.uid, adminName, action: 'DELIVERY_SETTINGS_UPDATED',
      targetType: 'settings', targetId: 'checkout', previous, next,
      createdAt: FieldValue.serverTimestamp(),
    });
  });
  return res.status(200).json(next);
}
