import { FieldValue } from 'firebase-admin/firestore';
import { adminDb, requireUser } from '../firebase-admin.js';
import { clientError, methodNotAllowed } from '../http.js';

const cleanText = (value, max = 500) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const validAmount = value => Number.isSafeInteger(value) && value >= 1 && value <= 10_000_000;
const iso = value => value?.toDate ? value.toDate().toISOString() : value || null;

// Customer-facing refund requests are requests for review only. They never
// initiate a payment transfer or approve themselves.
export async function customerRefunds(req, res) {
  const user = await requireUser(req);
  if (req.method === 'GET') {
    const snap = await adminDb.collection('refundRecords')
      .where('customerId', '==', user.uid).limit(100).get();
    const refunds = snap.docs.map(doc => ({
      id: doc.id, ...doc.data(),
      createdAt: iso(doc.data().createdAt), updatedAt: iso(doc.data().updatedAt),
    })).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    return res.json({ refunds });
  }
  if (req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);

  const body = req.body || {};
  if (Object.keys(body).some(key => !['orderDocumentId', 'amount', 'reason'].includes(key))) {
    throw clientError('Unexpected refund request field.');
  }
  const orderDocumentId = cleanText(body.orderDocumentId, 100);
  const reason = cleanText(body.reason, 500);
  const amount = body.amount;
  if (!/^[A-Za-z0-9_-]{8,100}$/.test(orderDocumentId)) throw clientError('Choose a valid order.');
  if (!reason || reason.length < 5) throw clientError('Please explain why you are requesting a refund (at least 5 characters).');
  if (!validAmount(amount)) throw clientError('Enter a valid refund amount in whole KES.');

  const orderRef = adminDb.collection('orders').doc(orderDocumentId);
  const refundRef = adminDb.collection('refundRecords').doc();
  const now = FieldValue.serverTimestamp();
  await adminDb.runTransaction(async tx => {
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists || orderSnap.data().customerId !== user.uid) {
      throw clientError('We could not find that order on your account.', 404);
    }
    const order = orderSnap.data();
    if (String(order.paymentStatus || '').toUpperCase() !== 'PAID') {
      throw clientError('Only orders with a successful payment can be refunded.', 409);
    }
    if (amount > Number(order.total || 0)) {
      throw clientError('The requested amount cannot exceed the order total.');
    }
    const status = String(order.refundStatus || 'NONE').toUpperCase();
    if (['REQUESTED', 'CONFIRMED'].includes(status)) {
      throw clientError('A refund request already exists for this order. Please check its status or contact support.', 409);
    }
    tx.set(refundRef, {
      type: 'REFUND', orderDocumentId, orderId: order.orderId || orderDocumentId,
      customerId: user.uid, amount, currency: order.currency || 'KES', reason,
      status: 'REQUESTED', requestedBy: user.uid, requesterRole: 'CUSTOMER',
      createdAt: now, updatedAt: now,
    });
    tx.update(orderRef, {
      refundStatus: 'REQUESTED', refundRequestedAmount: amount,
      refundReason: reason, refundRequestedBy: user.uid, refundRequestedAt: now,
      updatedAt: now,
    });
    tx.set(adminDb.collection('auditLogs').doc(), {
      actorUid: user.uid, actorType: 'CUSTOMER', action: 'REFUND_REQUESTED',
      entityType: 'ORDER', entityId: orderDocumentId, amount, reason, createdAt: now,
    });
  });
  return res.status(201).json({
    ok: true, refundRecordId: refundRef.id, status: 'REQUESTED',
    message: 'Your refund request has been sent to HerStep for review. No money has been sent yet.',
  });
}
