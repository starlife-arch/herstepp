import { FieldValue } from 'firebase-admin/firestore';
import { adminDb, requireAdmin } from '../firebase-admin.js';
import { clientError, methodNotAllowed } from '../http.js';

const iso = value => value?.toDate ? value.toDate().toISOString() : value || null;
const cleanText = (value, max = 500) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const asMoney = value => Number.isSafeInteger(value) && value >= 1 && value <= 10_000_000;

function refundStatus(order) {
  return String(order.refundStatus || (order.paymentStatus === 'REFUNDED' ? 'CONFIRMED' : 'NONE')).toUpperCase();
}

export async function adminRefunds(req, res) {
  const admin = await requireAdmin(req);
  if (req.method === 'GET') {
    const snap = await adminDb.collection('refundRecords').orderBy('createdAt', 'desc').limit(100).get().catch(async () => ({ docs: [] }));
    const refunds = snap.docs.map(doc => ({ id: doc.id, ...doc.data(), createdAt: iso(doc.data().createdAt), updatedAt: iso(doc.data().updatedAt) }));
    return res.json({ refunds });
  }
  if (req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);

  const body = req.body || {};
  const action = String(body.action || '').toUpperCase();
  const orderDocumentId = cleanText(body.orderDocumentId, 100);
  const reason = cleanText(body.reason, 500);
  if (!orderDocumentId || !/^[A-Za-z0-9_-]{8,100}$/.test(orderDocumentId)) throw clientError('A valid order reference is required.');
  if (!reason) throw clientError('Please enter a reason for this action.');

  const orderRef = adminDb.collection('orders').doc(orderDocumentId);
  const orderSnap = await orderRef.get();
  if (!orderSnap.exists) throw clientError('Order not found.', 404);
  const order = orderSnap.data();
  const now = FieldValue.serverTimestamp();

  if (action === 'REQUEST_REFUND' || action === 'CONFIRM_REFUND') {
    const amount = body.amount;
    if (order.paymentStatus !== 'PAID' && order.paymentStatus !== 'REFUNDED') throw clientError('Only a paid order can be refunded.', 409);
    if (!asMoney(amount) || amount > Number(order.total || 0)) throw clientError('Refund amount must be a positive whole KES amount no greater than the order total.');
    const existing = refundStatus(order);
    if (action === 'REQUEST_REFUND') {
      if (existing === 'CONFIRMED') throw clientError('This order already has a confirmed refund.', 409);
      if (existing === 'REQUESTED') throw clientError('A refund is already requested for this order.', 409);
      const ref = adminDb.collection('refundRecords').doc();
      await adminDb.runTransaction(async tx => {
        const fresh = await tx.get(orderRef);
        if (!fresh.exists || fresh.data().paymentStatus !== 'PAID') throw clientError('Order is no longer eligible for a refund.', 409);
        tx.set(ref, { type: 'REFUND', orderDocumentId, orderId: order.orderId || orderDocumentId, customerId: order.customerId || null, amount, currency: order.currency || 'KES', reason, status: 'REQUESTED', requestedBy: admin.uid, createdAt: now, updatedAt: now });
        tx.update(orderRef, { refundStatus: 'REQUESTED', refundRequestedAmount: amount, refundReason: reason, updatedAt: now });
        tx.set(adminDb.collection('auditLogs').doc(), { actorUid: admin.uid, action: 'REFUND_REQUESTED', entityType: 'ORDER', entityId: orderDocumentId, amount, reason, createdAt: now });
      });
      return res.status(201).json({ ok: true, status: 'REQUESTED', message: 'Refund request recorded. No money has been sent.' });
    }
    // CONFIRM_REFUND is a manual confirmation after the payment provider / finance process
    // has actually completed the refund. It deliberately does not call a payment provider.
    const refundRecordId = cleanText(body.refundRecordId, 100);
    const providerReference = cleanText(body.providerReference, 160);
    if (!refundRecordId || !providerReference) throw clientError('Refund record ID and external refund reference are required to confirm a completed refund.');
    const refundRef = adminDb.collection('refundRecords').doc(refundRecordId);
    await adminDb.runTransaction(async tx => {
      const [freshOrder, freshRefund] = await Promise.all([tx.get(orderRef), tx.get(refundRef)]);
      if (!freshOrder.exists || !freshRefund.exists) throw clientError('Refund request not found.', 404);
      const r = freshRefund.data();
      if (r.orderDocumentId !== orderDocumentId || r.status !== 'REQUESTED') throw clientError('Refund request is not eligible for confirmation.', 409);
      if (r.amount !== amount) throw clientError('Confirmed amount must match the requested amount.', 409);
      const paymentId = freshOrder.data().activePaymentId || freshOrder.data().paymentId;
      const paymentRef = typeof paymentId === 'string' && paymentId ? adminDb.collection('payments').doc(paymentId) : null;
      const paymentSnap = paymentRef ? await tx.get(paymentRef) : null;
      tx.update(refundRef, { status: 'CONFIRMED', providerReference, confirmedBy: admin.uid, confirmedAt: now, updatedAt: now });
      tx.update(orderRef, { paymentStatus: 'REFUNDED', refundStatus: 'CONFIRMED', refundConfirmedAt: now, refundConfirmedBy: admin.uid, updatedAt: now });
      if (paymentRef && paymentSnap?.exists) tx.update(paymentRef, { status: 'REFUNDED', refundReference: providerReference, refundedAt: now, updatedAt: now });
      tx.set(adminDb.collection('auditLogs').doc(), { actorUid: admin.uid, action: 'REFUND_CONFIRMED', entityType: 'ORDER', entityId: orderDocumentId, amount, reason, providerReference, createdAt: now });
      tx.set(adminDb.collection('orderStatusHistory').doc(), { orderId: freshOrder.data().orderId || orderDocumentId, orderDocumentId, customerId: freshOrder.data().customerId || null, eventType: 'REFUND_CONFIRMED', previousStatus: freshOrder.data().paymentStatus, newStatus: 'REFUNDED', paymentStatus: 'REFUNDED', note: reason, source: 'ADMIN', createdAt: now });
    });
    return res.json({ ok: true, status: 'CONFIRMED', message: 'Refund confirmation recorded.' });
  }

  if (action === 'CREATE_CREDIT_NOTE') {
    const amount = body.amount;
    if (!asMoney(amount) || amount > Number(order.total || 0)) throw clientError('Credit note amount must be a positive whole KES amount no greater than the order total.');
    const creditNoteNumber = `CN-${String(order.orderId || orderDocumentId).replace(/[^A-Za-z0-9-]/g, '')}-${Date.now().toString(36).toUpperCase()}`;
    const ref = adminDb.collection('creditNotes').doc();
    await adminDb.runTransaction(async tx => {
      const fresh = await tx.get(orderRef);
      if (!fresh.exists) throw clientError('Order not found.', 404);
      tx.create(ref, { creditNoteNumber, orderDocumentId, orderId: order.orderId || orderDocumentId, customerId: order.customerId || null, customerName: order.customerName || order.delivery?.fullName || '', amount, currency: order.currency || 'KES', reason, status: 'ISSUED', issuedBy: admin.uid, createdAt: now, updatedAt: now });
      tx.set(adminDb.collection('auditLogs').doc(), { actorUid: admin.uid, action: 'CREDIT_NOTE_ISSUED', entityType: 'ORDER', entityId: orderDocumentId, amount, reason, creditNoteNumber, createdAt: now });
    });
    return res.status(201).json({ ok: true, creditNoteNumber, status: 'ISSUED' });
  }

  if (action === 'RECORD_RETURN') {
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length || items.length > 12) throw clientError('Choose at least one returned item.');
    const normalized = items.map(item => {
      const productId = cleanText(item?.productId, 120);
      const size = String(item?.size ?? '');
      const quantity = item?.quantity;
      const condition = String(item?.condition || '').toUpperCase();
      if (!productId || !/^(?:3[0-9]|4[0-5])$/.test(size) || !Number.isInteger(quantity) || quantity < 1 || quantity > 10 || !['RESELLABLE', 'DAMAGED', 'INSPECTION'].includes(condition)) {
        throw clientError('Each returned item needs a valid product, shoe size, quantity and condition.');
      }
      const purchased = (Array.isArray(order.items) ? order.items : []).find(line => line.productId === productId && String(line.size) === size);
      if (!purchased || quantity > Number(purchased.quantity || 0)) throw clientError('Returned quantity cannot exceed the quantity purchased for that size.', 409);
      return { productId, size, quantity, condition, name: purchased.name || '' };
    });
    const ref = adminDb.collection('stockReturns').doc();
    await adminDb.runTransaction(async tx => {
      const fresh = await tx.get(orderRef);
      if (!fresh.exists) throw clientError('Order not found.', 404);
      tx.create(ref, { orderDocumentId, orderId: order.orderId || orderDocumentId, customerId: order.customerId || null, items: normalized, reason, status: 'PENDING_INSPECTION', recordedBy: admin.uid, createdAt: now, updatedAt: now });
      tx.set(adminDb.collection('auditLogs').doc(), { actorUid: admin.uid, action: 'STOCK_RETURN_RECORDED', entityType: 'ORDER', entityId: orderDocumentId, reason, itemCount: normalized.length, createdAt: now });
    });
    return res.status(201).json({ ok: true, stockReturnId: ref.id, status: 'PENDING_INSPECTION', message: 'Return recorded. Stock has not been increased.' });
  }

  if (action === 'APPROVE_RETURN_STOCK') {
    const stockReturnId = cleanText(body.stockReturnId, 100);
    if (!stockReturnId) throw clientError('Stock return reference is required.');
    const returnRef = adminDb.collection('stockReturns').doc(stockReturnId);
    await adminDb.runTransaction(async tx => {
      const returnSnap = await tx.get(returnRef);
      if (!returnSnap.exists || returnSnap.data().orderDocumentId !== orderDocumentId) throw clientError('Stock return not found for this order.', 404);
      const record = returnSnap.data();
      if (record.status !== 'PENDING_INSPECTION') throw clientError('This return has already been processed.', 409);
      const approved = record.items.filter(item => item.condition === 'RESELLABLE');
      const productRefs = [...new Set(approved.map(item => item.productId))].map(id => adminDb.collection('products').doc(id));
      const products = await tx.getAll(...productRefs);
      const byId = new Map(products.map((snap, i) => [productRefs[i].id, snap]));
      const updated = new Map();
      for (const item of approved) {
        const snap = byId.get(item.productId);
        if (!snap?.exists) throw clientError(`Returned product ${item.productId} no longer exists.`, 409);
        const data = snap.data();
        if (!Array.isArray(data.inventory)) throw clientError('Product inventory needs repair before stock can be returned.', 409);
        const current = updated.get(item.productId) || data.inventory.map(row => ({ ...row, quantity: Number(row.quantity) || 0 }));
        const idx = current.findIndex(row => String(row.size) === item.size);
        if (idx < 0) current.push({ size: item.size, quantity: item.quantity, costPrice: null });
        else current[idx] = { ...current[idx], quantity: (Number(current[idx].quantity) || 0) + item.quantity };
        updated.set(item.productId, current);
      }
      for (const [productId, inventory] of updated) {
        const derived = { stockQuantity: inventory.reduce((sum, row) => sum + (Number(row.quantity) || 0), 0), availableSizes: inventory.filter(row => (Number(row.quantity) || 0) > 0).map(row => row.size) };
        tx.update(adminDb.collection('products').doc(productId), { inventory, ...derived, updatedAt: now });
        tx.set(adminDb.collection('inventoryLogs').doc(), { action: 'RETURN_RESTOCK', orderDocumentId, stockReturnId, productId, changes: inventory, actorUid: admin.uid, reason, createdAt: now });
      }
      tx.update(returnRef, { status: 'PROCESSED', processedBy: admin.uid, processedAt: now, restockedItemCount: approved.length, updatedAt: now });
      tx.set(adminDb.collection('auditLogs').doc(), { actorUid: admin.uid, action: 'STOCK_RETURN_PROCESSED', entityType: 'ORDER', entityId: orderDocumentId, stockReturnId, restockedItemCount: approved.length, reason, createdAt: now });
    });
    return res.json({ ok: true, status: 'PROCESSED', message: 'Return processed. Only items marked resellable were returned to stock.' });
  }

  throw clientError('Unsupported refund or return action.');
}
