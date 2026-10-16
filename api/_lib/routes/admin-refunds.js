import { FieldValue } from 'firebase-admin/firestore';
import { waitUntil } from '@vercel/functions';
import { adminDb, requireAdmin } from '../firebase-admin.js';
import { clientError, methodNotAllowed } from '../http.js';
import { queueEmail, deliverQueuedEmailInline } from '../email-service.js';
import { buildEmail } from '../email-templates.js';
import { queueSms, deliverQueuedSms } from '../sms-service.js';
import { sendTelegramMessage } from '../telegram.js';
import { siteUrl } from '../site-url.js';

const iso = value => value?.toDate ? value.toDate().toISOString() : value || null;
const cleanText = (value, max = 500) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const asMoney = value => Number.isSafeInteger(value) && value >= 1 && value <= 10_000_000;

function refundStatus(order) {
  return String(order.refundStatus || (order.paymentStatus === 'REFUNDED' ? 'CONFIRMED' : 'NONE')).toUpperCase();
}

export async function adminRefunds(req, res) {
  const admin = await requireAdmin(req);
  if (req.method === 'GET') {
    const [refundSnap, returnSnap, creditSnap] = await Promise.all([
      adminDb.collection('refundRecords').orderBy('createdAt', 'desc').limit(100).get().catch(() => ({ docs: [] })),
      adminDb.collection('stockReturns').orderBy('createdAt', 'desc').limit(100).get().catch(() => ({ docs: [] })),
      adminDb.collection('creditNotes').orderBy('createdAt', 'desc').limit(100).get().catch(() => ({ docs: [] })),
    ]);
    const mapRows = snap => snap.docs.map(doc => ({ id: doc.id, ...doc.data(), createdAt: iso(doc.data().createdAt), updatedAt: iso(doc.data().updatedAt) }));
    return res.json({ refunds: mapRows(refundSnap), stockReturns: mapRows(returnSnap), creditNotes: mapRows(creditSnap) });
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
        const priorRefunds = await tx.get(adminDb.collection('refundRecords').where('orderDocumentId', '==', orderDocumentId));
        const alreadyRefunded = priorRefunds.docs.filter(doc => doc.data().status === 'CONFIRMED').reduce((sum, doc) => sum + (Number(doc.data().amount) || 0), 0);
        if (amount > Number(fresh.data().total || 0) - alreadyRefunded) throw clientError('Refund amount exceeds the remaining refundable balance.', 409);
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
    const notification = await adminDb.runTransaction(async tx => {
      const [freshOrder, freshRefund, priorRefunds] = await Promise.all([
        tx.get(orderRef), tx.get(refundRef),
        tx.get(adminDb.collection('refundRecords').where('orderDocumentId', '==', orderDocumentId)),
      ]);
      if (!freshOrder.exists || !freshRefund.exists) throw clientError('Refund request not found.', 404);
      const r = freshRefund.data();
      if (r.orderDocumentId !== orderDocumentId || !['REQUESTED', 'APPROVED'].includes(r.status)) throw clientError('Refund request is not eligible for confirmation.', 409);
      if (r.amount !== amount) throw clientError('Confirmed amount must match the requested amount.', 409);
      const alreadyRefunded = priorRefunds.docs.filter(doc => doc.id !== refundRecordId && doc.data().status === 'CONFIRMED').reduce((sum, doc) => sum + (Number(doc.data().amount) || 0), 0);
      if (amount > Number(freshOrder.data().total || 0) - alreadyRefunded) throw clientError('Confirmed amount exceeds the remaining refundable balance.', 409);
      const paymentId = freshOrder.data().activePaymentId || freshOrder.data().paymentId;
      const paymentRef = typeof paymentId === 'string' && paymentId ? adminDb.collection('payments').doc(paymentId) : null;
      const paymentSnap = paymentRef ? await tx.get(paymentRef) : null;
      tx.update(refundRef, { status: 'CONFIRMED', providerReference, confirmedBy: admin.uid, confirmedAt: now, updatedAt: now });
      const isFullRefund = alreadyRefunded + amount >= Number(freshOrder.data().total || 0);
      tx.update(orderRef, { ...(isFullRefund ? { paymentStatus: 'REFUNDED' } : {}), refundStatus: isFullRefund ? 'CONFIRMED' : 'PARTIALLY_REFUNDED', refundConfirmedAmount: amount, refundConfirmedAt: now, refundConfirmedBy: admin.uid, updatedAt: now });
      if (isFullRefund && paymentRef && paymentSnap?.exists) tx.update(paymentRef, { status: 'REFUNDED', refundReference: providerReference, refundedAt: now, updatedAt: now });
      tx.set(adminDb.collection('auditLogs').doc(), { actorUid: admin.uid, action: 'REFUND_CONFIRMED', entityType: 'ORDER', entityId: orderDocumentId, amount, reason, providerReference, createdAt: now });
      tx.set(adminDb.collection('orderStatusHistory').doc(), { orderId: freshOrder.data().orderId || orderDocumentId, orderDocumentId, customerId: freshOrder.data().customerId || null, eventType: 'REFUND_CONFIRMED', previousStatus: freshOrder.data().paymentStatus, newStatus: isFullRefund ? 'REFUNDED' : 'PARTIALLY_REFUNDED', paymentStatus: isFullRefund ? 'REFUNDED' : freshOrder.data().paymentStatus, note: reason, source: 'ADMIN', createdAt: now });
      const freshData = freshOrder.data();
      const customerEmail = cleanText(freshData.customerEmail || freshData.email || freshData.delivery?.email, 254).toLowerCase();
      const customerPhone = freshData.delivery?.phone || freshData.phone || '';
      const orderNumber = cleanText(freshData.orderId || orderDocumentId, 80);
      const amountText = `KSh ${amount.toLocaleString('en-KE')}`;
      let emailKey = null;
      if (customerEmail) {
        const email = buildEmail(
          `Refund approved — ${orderNumber}`,
          `Hi ${freshData.customerName || freshData.delivery?.fullName || 'there'},\n\nYour refund request for order ${orderNumber} has been approved and marked as completed by HerStep Collection.\nAmount: ${amountText}\nRefund reference: ${providerReference}\n\nIf you do not see the funds yet, please allow your payment provider time to process them. Contact HerStep Support if you need help.`,
          { ctaLabel: 'View my orders', ctaUrl: `${siteUrl()}/account` },
        );
        emailKey = `${refundRecordId}-REFUND-CONFIRMED-EMAIL`;
        queueEmail(tx, adminDb, { key: emailKey, purpose: 'refunds', to: customerEmail, subject: email.subject, htmlContent: email.htmlContent });
      }
      const smsQueued = queueSms(tx, adminDb, {
        key: `${refundRecordId}-REFUND-CONFIRMED-SMS`,
        to: customerPhone,
        message: `HerStep Collection: Refund approved/completed for order ${orderNumber}, ${amountText}. Reference: ${providerReference}. If funds are delayed, contact support: ${siteUrl()}/support`,
      });
      return { emailKey, smsQueued, customerEmail, customerName: freshData.customerName || freshData.delivery?.fullName || 'Customer', orderNumber, amount, providerReference, isFullRefund };
    });
    waitUntil(Promise.all([
      notification.emailKey ? deliverQueuedEmailInline(adminDb, notification.emailKey) : Promise.resolve(null),
      notification.smsQueued ? deliverQueuedSms(adminDb, `${refundRecordId}-REFUND-CONFIRMED-SMS`) : Promise.resolve(null),
      sendTelegramMessage(`✅ Refund confirmed\nOrder: ${notification.orderNumber}\nCustomer: ${notification.customerName}\nAmount: KSh ${notification.amount.toLocaleString('en-KE')}\nReference: ${notification.providerReference}\nStatus: ${notification.isFullRefund ? 'Fully refunded' : 'Partial refund'}`),
    ]).catch(error => console.error('[admin-refunds] confirmation notification failed:', error?.message || error)));
    return res.json({ ok: true, status: 'CONFIRMED', message: 'Refund confirmation recorded and notifications queued.' });
  }

  if (action === 'APPROVE_REFUND') {
    const refundRecordId = cleanText(body.refundRecordId, 100);
    if (!refundRecordId) throw clientError('Choose a pending refund request to approve.');
    const refundRef = adminDb.collection('refundRecords').doc(refundRecordId);
    const notification = await adminDb.runTransaction(async tx => {
      const [freshOrder, freshRefund] = await Promise.all([tx.get(orderRef), tx.get(refundRef)]);
      if (!freshOrder.exists || !freshRefund.exists || freshRefund.data().orderDocumentId !== orderDocumentId) throw clientError('Refund request not found for this order.', 404);
      const refund = freshRefund.data();
      if (refund.status !== 'REQUESTED') throw clientError('Only a pending refund request can be approved.', 409);
      const freshData = freshOrder.data();
      tx.update(refundRef, { status: 'APPROVED', approvalNote: reason, approvedBy: admin.uid, approvedAt: now, updatedAt: now });
      tx.update(orderRef, { refundStatus: 'APPROVED', refundApprovedAt: now, refundApprovalNote: reason, updatedAt: now });
      tx.set(adminDb.collection('auditLogs').doc(), { actorUid: admin.uid, action: 'REFUND_APPROVED', entityType: 'ORDER', entityId: orderDocumentId, refundRecordId, amount: refund.amount, reason, createdAt: now });
      const customerEmail = cleanText(freshData.customerEmail || freshData.email || freshData.delivery?.email, 254).toLowerCase();
      const customerPhone = freshData.delivery?.phone || freshData.phone || '';
      const orderNumber = cleanText(freshData.orderId || orderDocumentId, 80);
      const amountText = `KSh ${Number(refund.amount || 0).toLocaleString('en-KE')}`;
      let emailKey = null;
      if (customerEmail) {
        const email = buildEmail(
          `Refund request approved — ${orderNumber}`,
          `Hi ${freshData.customerName || freshData.delivery?.fullName || 'there'},\n\nYour refund request for order ${orderNumber} has been approved.\nApproved amount: ${amountText}\n\nOur team is arranging the refund. This approval does not mean the money has already been sent; we will notify you again when the refund is confirmed as completed.\n\nNote from the team: ${reason}`,
          { ctaLabel: 'View my orders', ctaUrl: `${siteUrl()}/account` },
        );
        emailKey = `${refundRecordId}-REFUND-APPROVED-EMAIL`;
        queueEmail(tx, adminDb, { key: emailKey, purpose: 'refunds', to: customerEmail, subject: email.subject, htmlContent: email.htmlContent });
      }
      const smsQueued = queueSms(tx, adminDb, {
        key: `${refundRecordId}-REFUND-APPROVED-SMS`,
        to: customerPhone,
        message: `HerStep Collection: Your refund request for order ${orderNumber} was approved for KSh ${Number(refund.amount || 0).toLocaleString('en-KE')}. Payment is being arranged; this is not confirmation that funds have been sent.`,
      });
      return { emailKey, smsQueued, customerEmail, customerName: freshData.customerName || freshData.delivery?.fullName || 'Customer', orderNumber, amount: refund.amount };
    });
    waitUntil(Promise.all([
      notification.emailKey ? deliverQueuedEmailInline(adminDb, notification.emailKey) : Promise.resolve(null),
      notification.smsQueued ? deliverQueuedSms(adminDb, `${refundRecordId}-REFUND-APPROVED-SMS`) : Promise.resolve(null),
      sendTelegramMessage(`🟡 Refund request approved\nOrder: ${notification.orderNumber}\nCustomer: ${notification.customerName}\nAmount: KSh ${Number(notification.amount || 0).toLocaleString('en-KE')}\nNote: ${reason}\nRefund still needs to be sent and confirmed.`),
    ]).catch(error => console.error('[admin-refunds] approval notification failed:', error?.message || error)));
    return res.json({ ok: true, status: 'APPROVED', message: 'Refund request approved and customer notifications queued. Send the refund separately, then confirm it here.' });
  }

  if (action === 'REJECT_REFUND') {
    const refundRecordId = cleanText(body.refundRecordId, 100);
    if (!refundRecordId) throw clientError('Choose a pending refund request to reject.');
    const refundRef = adminDb.collection('refundRecords').doc(refundRecordId);
    const notification = await adminDb.runTransaction(async tx => {
      const [freshOrder, freshRefund] = await Promise.all([tx.get(orderRef), tx.get(refundRef)]);
      if (!freshOrder.exists || !freshRefund.exists || freshRefund.data().orderDocumentId !== orderDocumentId) throw clientError('Refund request not found for this order.', 404);
      const refund = freshRefund.data();
      if (refund.status !== 'REQUESTED') throw clientError('Only a pending refund request can be rejected.', 409);
      const freshData = freshOrder.data();
      tx.update(refundRef, { status: 'REJECTED', rejectionReason: reason, rejectedBy: admin.uid, rejectedAt: now, updatedAt: now });
      tx.update(orderRef, { refundStatus: 'REJECTED', refundRejectedReason: reason, refundRejectedAt: now, updatedAt: now });
      tx.set(adminDb.collection('auditLogs').doc(), { actorUid: admin.uid, action: 'REFUND_REJECTED', entityType: 'ORDER', entityId: orderDocumentId, refundRecordId, amount: refund.amount, reason, createdAt: now });
      const customerEmail = cleanText(freshData.customerEmail || freshData.email || freshData.delivery?.email, 254).toLowerCase();
      const customerPhone = freshData.delivery?.phone || freshData.phone || '';
      const orderNumber = cleanText(freshData.orderId || orderDocumentId, 80);
      let emailKey = null;
      if (customerEmail) {
        const email = buildEmail(
          `Refund request update — ${orderNumber}`,
          `Hi ${freshData.customerName || freshData.delivery?.fullName || 'there'},\n\nWe have reviewed your refund request for order ${orderNumber}, and unfortunately it has not been approved.\nRequested amount: KSh ${Number(refund.amount || 0).toLocaleString('en-KE')}\nReason: ${reason}\n\nIf you believe this decision needs another review or have additional evidence, please contact HerStep Support and reference your order number.`,
          { ctaLabel: 'Contact support', ctaUrl: `${siteUrl()}/support` },
        );
        emailKey = `${refundRecordId}-REFUND-REJECTED-EMAIL`;
        queueEmail(tx, adminDb, { key: emailKey, purpose: 'refunds', to: customerEmail, subject: email.subject, htmlContent: email.htmlContent });
      }
      const smsQueued = queueSms(tx, adminDb, {
        key: `${refundRecordId}-REFUND-REJECTED-SMS`,
        to: customerPhone,
        message: `HerStep Collection: Your refund request for order ${orderNumber} was not approved. Reason: ${reason.slice(0, 160)}. Contact support: ${siteUrl()}/support`,
      });
      return { emailKey, smsQueued, customerEmail, customerName: freshData.customerName || freshData.delivery?.fullName || 'Customer', orderNumber, amount: refund.amount };
    });
    waitUntil(Promise.all([
      notification.emailKey ? deliverQueuedEmailInline(adminDb, notification.emailKey) : Promise.resolve(null),
      notification.smsQueued ? deliverQueuedSms(adminDb, `${refundRecordId}-REFUND-REJECTED-SMS`) : Promise.resolve(null),
      sendTelegramMessage(`❌ Refund request rejected\nOrder: ${notification.orderNumber}\nCustomer: ${notification.customerName}\nAmount: KSh ${Number(notification.amount || 0).toLocaleString('en-KE')}\nReason: ${reason}`),
    ]).catch(error => console.error('[admin-refunds] rejection notification failed:', error?.message || error)));
    return res.json({ ok: true, status: 'REJECTED', message: 'Refund request rejected and customer notifications queued.' });
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
      const inspectionResults = Array.isArray(body.inspectionResults) ? body.inspectionResults : [];
      const resultByKey = new Map(inspectionResults.map(item => [String(item.productId) + ':' + String(item.size), String(item.condition || '').toUpperCase()]));
      const inspectedItems = record.items.map(item => {
        const condition = resultByKey.get(String(item.productId) + ':' + String(item.size));
        if (!condition || !['RESELLABLE', 'DAMAGED'].includes(condition)) throw clientError('Inspect every returned item and mark it Resalable or Damaged before processing.');
        return { ...item, condition };
      });
      const approved = inspectedItems.filter(item => item.condition === 'RESELLABLE');
      const productRefs = [...new Set(approved.map(item => item.productId))].map(id => adminDb.collection('products').doc(id));
      const products = productRefs.length ? await tx.getAll(...productRefs) : [];
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
      tx.update(returnRef, { items: inspectedItems, status: 'PROCESSED', processedBy: admin.uid, processedAt: now, restockedItemCount: approved.length, updatedAt: now });
      tx.set(adminDb.collection('auditLogs').doc(), { actorUid: admin.uid, action: 'STOCK_RETURN_PROCESSED', entityType: 'ORDER', entityId: orderDocumentId, stockReturnId, restockedItemCount: approved.length, reason, createdAt: now });
    });
    return res.json({ ok: true, status: 'PROCESSED', message: 'Return processed. Only items marked resellable were returned to stock.' });
  }

  throw clientError('Unsupported refund or return action.');
}
