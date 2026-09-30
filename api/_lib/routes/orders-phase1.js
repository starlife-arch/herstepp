import { FieldValue } from 'firebase-admin/firestore';
import { adminDb, requireAdmin, requireUser } from '../firebase-admin.js';
import { clientError, methodNotAllowed } from '../http.js';
const iso = v => v?.toDate ? v.toDate().toISOString() : v || null;
const rows = s => s.docs.map(d => ({ id: d.id, ...d.data(), createdAt: iso(d.data().createdAt), updatedAt: iso(d.data().updatedAt) }));

export async function track(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
  const u = await requireUser(req);
  const id = req.query.orderDocumentId;
  const o = await adminDb.collection('orders').doc(id).get();
  if (!o.exists) throw clientError('Order not found.', 404);
  if (o.data().customerId !== u.uid) throw clientError('Forbidden.', 403);
  const h = await adminDb.collection('orderStatusHistory').where('orderDocumentId', '==', id).orderBy('createdAt').get();
  const d = o.data();
  return res.json({
    order: {
      id: o.id, orderId: d.orderId, orderStatus: d.orderStatus, paymentStatus: d.paymentStatus,
      total: d.total, currency: d.currency, deliveryMethod: d.delivery?.deliveryMethod,
      items: (d.items || []).map(({ productId, name, size, quantity, lineTotal, imageUrl }) => ({ productId, name, size, quantity, lineTotal, imageUrl })),
      history: h.docs.map(x => ({ ...x.data(), createdAt: iso(x.data().createdAt) })),
    },
  });
}

const transitions = { PENDING: ['PROCESSING', 'CANCELLED'], PROCESSING: ['PROCESSED', 'CANCELLED'], PROCESSED: ['OUT_FOR_DELIVERY', 'CANCELLED'], OUT_FOR_DELIVERY: ['DELIVERED'] };

export async function adminOrders(req, res) {
  const a = await requireAdmin(req);
  if (req.method === 'GET') {
    let q = adminDb.collection('orders');
    if (req.query.orderStatus) q = q.where('orderStatus', '==', req.query.orderStatus);
    const s = await q.orderBy('createdAt', 'desc').get();
    return res.json(s.docs.map(x => ({ id: x.id, ...x.data(), createdAt: iso(x.data().createdAt) })));
  }
  if (req.method !== 'PATCH') return methodNotAllowed(res, ['GET', 'PATCH']);
  const { orderDocumentId, orderStatus, note } = req.body || {};
  await adminDb.runTransaction(async t => {
    const r = adminDb.collection('orders').doc(orderDocumentId), s = await t.get(r);
    if (!s.exists) throw clientError('Order not found.', 404);
    const d = s.data();
    if (!transitions[d.orderStatus]?.includes(orderStatus)) throw clientError('That order status transition is not allowed.', 409);
    if (orderStatus === 'PROCESSING' && d.paymentStatus !== 'PAID') throw clientError('Payment must be confirmed before processing.', 409);
    t.update(r, { orderStatus, updatedAt: FieldValue.serverTimestamp() });
    // Cancelling an order that still holds reserved stock returns it to inventory, in this same transaction.
    if (orderStatus === 'CANCELLED' && d.inventoryReserved === true) {
      for (const item of d.items || []) {
        const pRef = adminDb.collection('products').doc(item.productId);
        const pSnap = await t.get(pRef);
        if (!pSnap.exists) continue;
        const pd = pSnap.data();
        const index = (pd.inventory || []).findIndex(i => i.size === item.size);
        if (index === -1) continue;
        const previousQuantity = pd.inventory[index].quantity;
        const newQuantity = previousQuantity + item.quantity;
        const inventory = pd.inventory.map((i, n) => (n === index ? { size: i.size, quantity: newQuantity } : i));
        t.update(pRef, {
          inventory,
          stockQuantity: (pd.stockQuantity || 0) + item.quantity,
          availableSizes: inventory.filter(i => i.quantity > 0).map(i => i.size),
          updatedAt: FieldValue.serverTimestamp(),
        });
        t.set(adminDb.collection('inventoryLogs').doc(), { productId: item.productId, size: item.size, previousQuantity, newQuantity, reason: 'ORDER_CANCELLED', orderId: d.orderId, orderDocumentId, adminUid: a.uid, createdAt: FieldValue.serverTimestamp() });
      }
      t.update(r, { inventoryReserved: false });
    }
    const hid = adminDb.collection('orderStatusHistory').doc();
    t.set(hid, { orderId: d.orderId, orderDocumentId, customerId: d.customerId, eventType: 'ORDER_STATUS_CHANGED', previousStatus: d.orderStatus, newStatus: orderStatus, paymentStatus: d.paymentStatus, note: typeof note === 'string' ? note : '', source: 'ADMIN', adminUid: a.uid, createdAt: FieldValue.serverTimestamp() });
    t.set(adminDb.collection('notifications').doc(`${orderDocumentId}-ORDER_${orderStatus}`), { customerId: d.customerId, orderDocumentId, event: 'ORDER_STATUS_CHANGED', title: 'Order update', body: `Your order is now ${orderStatus}.`, readAt: null, createdAt: FieldValue.serverTimestamp() });
  });
  return res.json({ ok: true });
}
