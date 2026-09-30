// Order routes shared by customers and admins (dispatched from api/orders.js
// and api/admin.js). Admin status changes delegate to adminOrderTransitionCore
// in api/_lib/order-core.js so that cancelling an unpaid order restores the
// reserved stock (NEW inventory arrays + inventoryLogs) inside ONE
// transaction — never via dotted paths.
import { FieldValue } from 'firebase-admin/firestore';
import { adminDb, requireAdmin, requireUser } from '../firebase-admin.js';
import { clientError, methodNotAllowed } from '../http.js';
import { adminOrderTransitionCore } from '../order-core.js';

const iso = v => (v?.toDate ? v.toDate().toISOString() : v || null);
const rows = s => s.docs.map(d => ({ id: d.id, ...d.data(), createdAt: iso(d.data().createdAt), updatedAt: iso(d.data().updatedAt) }));

export async function track(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
  const u = await requireUser(req);
  const rawId = Array.isArray(req.query.orderDocumentId) ? req.query.orderDocumentId[0] : req.query.orderDocumentId;
  const orderIdHint = Array.isArray(req.query.orderId) ? req.query.orderId[0] : req.query.orderId;

  let docSnap = null;
  if (typeof rawId === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(rawId)) {
    const direct = await adminDb.collection('orders').doc(rawId).get();
    if (direct.exists) docSnap = direct;
  }
  if (!docSnap && typeof orderIdHint === 'string' && /^HS-\d{4}-\d{6}$/.test(orderIdHint.trim())) {
    const byNumber = await adminDb.collection('orders').where('orderId', '==', orderIdHint.trim()).limit(1).get();
    if (!byNumber.empty) docSnap = byNumber.docs[0];
  }
  if (!docSnap) throw clientError('Order not found.', 404);
  const d = docSnap.data();
  if (d.customerId !== u.uid) throw clientError('Forbidden.', 403);

  const h = await adminDb.collection('orderStatusHistory').where('orderDocumentId', '==', docSnap.id).orderBy('createdAt').get();
  return res.json({
    order: {
      id: docSnap.id,
      orderId: d.orderId,
      orderStatus: d.orderStatus,
      paymentStatus: d.paymentStatus,
      subtotal: Number(d.subtotal) || 0,
      deliveryFee: Number(d.deliveryFee) || 0,
      discount: Number(d.discount) || 0,
      total: Number(d.total) || 0,
      currency: d.currency || 'KES',
      createdAt: iso(d.createdAt),
      delivery: {
        fullName: d.delivery?.fullName ?? '',
        phone: d.delivery?.phone ?? '',
        deliveryMethod: d.delivery?.deliveryMethod ?? 'COLLECTION',
        location: d.delivery?.location ?? '',
        instructions: d.delivery?.notes ?? d.delivery?.instructions ?? '',
      },
      items: (Array.isArray(d.items) ? d.items : []).map(({ productId, name, size, quantity, unitPrice, lineTotal, imageUrl }) => ({
        productId, name, size, quantity, unitPrice, lineTotal, imageUrl: imageUrl ?? null,
      })),
      history: h.docs.map(x => ({ ...x.data(), createdAt: iso(x.data().createdAt) })),
    },
  });
}

export async function adminOrders(req, res) {
  const a = await requireAdmin(req);
  if (req.method === 'GET') {
    let q = adminDb.collection('orders');
    const statusFilter = Array.isArray(req.query.orderStatus) ? req.query.orderStatus[0] : req.query.orderStatus;
    if (typeof statusFilter === 'string' && statusFilter) q = q.where('orderStatus', '==', statusFilter);
    const s = await q.orderBy('createdAt', 'desc').limit(200).get();
    return res.json(rows(s).map(o => ({
      id: o.id,
      orderId: o.orderId ?? o.id,
      customerName: o.customerName ?? '',
      customerPhone: o.customerPhone ?? o.delivery?.phone ?? '',
      customerEmail: o.customerEmail ?? '',
      items: Array.isArray(o.items) ? o.items : [],
      subtotal: Number(o.subtotal) || 0,
      deliveryFee: Number(o.deliveryFee) || 0,
      total: Number(o.total) || 0,
      currency: o.currency || 'KES',
      paymentStatus: o.paymentStatus ?? null,
      orderStatus: o.orderStatus ?? null,
      paymentReference: o.paymentReference ?? null,
      paymentId: o.paymentId ?? null,
      delivery: o.delivery ?? null,
      createdAt: o.createdAt,
      updatedAt: o.updatedAt,
    })));
  }
  if (req.method !== 'PATCH') return methodNotAllowed(res, ['GET', 'PATCH']);
  const { orderDocumentId, orderStatus, note } = req.body || {};
  await adminOrderTransitionCore(adminDb, { serverTimestamp: () => FieldValue.serverTimestamp() }, {
    actorUid: a.uid,
    orderDocumentId,
    orderStatus,
    note,
  });
  return res.json({ ok: true });
}
