// GET/PATCH /api/admin/delivery — read & update settings/checkout delivery
// configuration through the SHARED module api/_lib/delivery.js (single source
// of truth for the fee rules). PATCH validates strictly, merges into
// settings/checkout, writes an auditLogs entry {previous, next} and returns
// the new normalised settings.
import { FieldValue } from 'firebase-admin/firestore';
import { currentDb, requireAdmin } from '../firebase-admin.js';
import { clientError, methodNotAllowed } from '../http.js';
import { normalizeDelivery, validateDelivery, COLLECTION_LOCATION } from '../delivery.js';

export default async function adminDelivery(req, res) {
  const db = currentDb();

  if (req.method === 'GET') {
    const snapshot = await db.doc('settings/checkout').get();
    const settings = normalizeDelivery(snapshot.exists ? snapshot.data() : {});
    return res.json({ ...settings, collectionLocation: COLLECTION_LOCATION });
  }

  if (req.method === 'PATCH') {
    const admin = await requireAdmin(req);
    let next;
    try {
      next = validateDelivery(req.body && typeof req.body === 'object' ? req.body : {});
    } catch (error) {
      throw clientError(error?.message || 'The delivery settings are not valid.');
    }

    const ref = db.doc('settings/checkout');
    const before = await ref.get();
    const previous = normalizeDelivery(before.exists ? before.data() : {});

    // Merge (never clobber sibling keys such as collectionEnabled). outsideJuja
    // is preserved untouched by validateDelivery when the payload omits it.
    await ref.set(
      { deliveryEnabled: next.deliveryEnabled, deliveryRates: next.deliveryRates, updatedAt: FieldValue.serverTimestamp() },
      { merge: true },
    );

    await db.collection('auditLogs').add({
      adminId: admin.uid,
      adminName: admin.name || admin.email || null,
      action: 'admin.delivery.update',
      targetType: 'settings/checkout',
      targetId: 'checkout',
      previous,
      next,
      createdAt: FieldValue.serverTimestamp(),
    });

    return res.json({ ...next, collectionLocation: COLLECTION_LOCATION });
  }

  return methodNotAllowed(res, 'GET, PATCH');
}
