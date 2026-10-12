import { FieldValue } from 'firebase-admin/firestore';
import { adminDb, requireAdmin } from '../firebase-admin.js';
import { clientError, methodNotAllowed } from '../http.js';

// Restricted historical cost editor: only item cost fields on PAID orders may be changed.
export async function orderCosts(req, res) {
  const admin = await requireAdmin(req);
  const ordersRef = adminDb.collection('orders');
  if (req.method === 'GET') {
    const snapshot = await ordersRef.where('paymentStatus', '==', 'PAID').orderBy('createdAt', 'desc').limit(100).get();
    const rows = [];
    for (const doc of snapshot.docs) {
      const order = doc.data();
      const items = Array.isArray(order.items) ? order.items : [];
      items.forEach((item, itemIndex) => {
        const value = item.unitCost ?? item.costPrice ?? item.cost;
        rows.push({
          orderId: doc.id,
          itemIndex,
          productId: String(item.productId || ''),
          name: String(item.name || 'Product').slice(0, 120),
          size: String(item.size || ''),
          quantity: Math.max(0, Number(item.quantity) || 0),
          unitPrice: Math.max(0, Number(item.unitPrice) || 0),
          unitCost: value === null || value === undefined || value === '' ? null : Number(value),
          orderCreatedAt: order.createdAt?.toDate ? order.createdAt.toDate().toISOString() : (typeof order.createdAt === 'string' ? order.createdAt : null),
        });
      });
    }
    return res.status(200).json(rows.filter(row => row.unitCost === null));
  }
  if (req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);
  const orderId = typeof req.body?.orderId === 'string' ? req.body.orderId.trim() : '';
  const itemIndex = req.body?.itemIndex;
  const unitCost = req.body?.unitCost;
  if (!orderId || orderId.length > 160) throw clientError('Choose a valid paid order.');
  if (!Number.isInteger(itemIndex) || itemIndex < 0 || itemIndex > 99) throw clientError('Choose a valid order item.');
  if (!Number.isInteger(unitCost) || unitCost < 0 || unitCost > 1000000000) throw clientError('Enter a non-negative whole KSh cost price.');
  const ref = ordersRef.doc(orderId);
  await adminDb.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw clientError('Order not found.', 404);
    const order = snap.data();
    if (String(order.paymentStatus || '').toUpperCase() !== 'PAID') throw clientError('Only paid orders can receive historical cost records.', 409);
    const items = Array.isArray(order.items) ? order.items.map(item => ({ ...item })) : [];
    if (!items[itemIndex]) throw clientError('Order item not found.', 404);
    items[itemIndex].unitCost = unitCost;
    tx.update(ref, { items, updatedAt: FieldValue.serverTimestamp() });
    tx.set(adminDb.collection('adminCostAudit').doc(), {
      actorUid: admin.uid, orderId, itemIndex, unitCost,
      createdAt: FieldValue.serverTimestamp(),
    });
  });
  return res.status(200).json({ ok: true });
}
