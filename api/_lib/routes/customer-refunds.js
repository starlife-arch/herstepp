import { FieldValue } from 'firebase-admin/firestore';
import { waitUntil } from '@vercel/functions';
import { adminDb, requireUser } from '../firebase-admin.js';
import { clientError, methodNotAllowed } from '../http.js';
import { queueEmail, deliverQueuedEmailInline } from '../email-service.js';
import { buildEmail } from '../email-templates.js';
import { siteUrl } from '../site-url.js';
import { queueSms, deliverQueuedSms } from '../sms-service.js';

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
  const queuedEmailKeys = new Set();
  let smsQueued = false;
  let customerPhone = '';
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
    const priorRefunds = await tx.get(adminDb.collection('refundRecords').where('orderDocumentId', '==', orderDocumentId));
    const alreadyRefunded = priorRefunds.docs.filter(doc => doc.data().status === 'CONFIRMED').reduce((sum, doc) => sum + (Number(doc.data().amount) || 0), 0);
    if (amount > Number(order.total || 0) - alreadyRefunded) {
      throw clientError('The requested amount exceeds the remaining refundable balance.');
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

    // Queue best-effort customer and refund-team notifications in the same
    // transaction as the request. Delivery happens only after commit.
    const customerEmail = cleanText(user.email || order.customerEmail || order.email, 254).toLowerCase();
    customerPhone = order.delivery?.phone || order.phone || user.phoneNumber || '';
    const orderNumber = cleanText(order.orderId || orderDocumentId, 80);
    const amountText = `KSh ${amount.toLocaleString('en-KE')}`;
    const customerTemplate = buildEmail(
      `Refund request received — ${orderNumber}`,
      `Hi ${user.displayName || order.customerName || order.delivery?.fullName || 'there'},\n\nWe have received your refund request for order ${orderNumber}.\nRequested amount: ${amountText}\nReason: ${reason}\n\nOur team will review your request and update you. This email confirms receipt only; no money has been sent yet.`,
      { ctaLabel: 'View my account', ctaUrl: `${siteUrl()}/account` },
    );
    if (customerEmail) {
      const key = `${refundRef.id}-REFUND-CUSTOMER-EMAIL`;
      try {
        queueEmail(tx, adminDb, { key, purpose: 'refunds', to: customerEmail, subject: customerTemplate.subject, htmlContent: customerTemplate.htmlContent });
        queuedEmailKeys.add(key);
      } catch (error) {
        console.error('[customer-refunds] customer email queue failed:', error?.message || error);
      }
    }
    const env = globalThis.process?.env || {};
    const refundInbox = cleanText(env.REFUNDS_NOTIFICATION_EMAIL || env.BREVO_SENDER_REFUNDS, 254).toLowerCase();
    if (refundInbox) {
      const adminTemplate = buildEmail(
        `New refund request — ${orderNumber}`,
        `A customer has submitted a refund request.\n\nOrder: ${orderNumber}\nCustomer: ${cleanText(user.displayName || order.customerName || order.delivery?.fullName || 'Customer', 120)}\nCustomer email: ${customerEmail || 'Not available'}\nRequested amount: ${amountText}\nReason: ${reason}\n\nReview this request in the HerStep Collection admin dashboard. No refund has been paid automatically.`,
        { ctaLabel: 'Open HerStep Collection', ctaUrl: `${siteUrl()}/admin` },
      );
      const key = `${refundRef.id}-REFUND-TEAM-EMAIL`;
      try {
        queueEmail(tx, adminDb, { key, purpose: 'refunds', to: refundInbox, subject: adminTemplate.subject, htmlContent: adminTemplate.htmlContent });
        queuedEmailKeys.add(key);
      } catch (error) {
        console.error('[customer-refunds] team email queue failed:', error?.message || error);
      }
    }
    try {
      smsQueued = queueSms(tx, adminDb, {
        key: `${refundRef.id}-REFUND-REQUESTED-SMS`,
        to: customerPhone,
        message: `HerStep Collection: We received your refund request for order ${orderNumber} (${amountText}). Our team will review it. No money has been sent yet. Visit ${siteUrl()}/account`,
      });
    } catch (error) {
      console.error('[customer-refunds] SMS queue failed:', error?.message || error);
    }
  });
  // waitUntil keeps best-effort notifications alive after the response while
  // preventing provider outages from failing the refund request itself.
  waitUntil(Promise.all([
    ...Array.from(queuedEmailKeys, key => deliverQueuedEmailInline(adminDb, key)),
    ...(smsQueued ? [deliverQueuedSms(adminDb, `${refundRef.id}-REFUND-REQUESTED-SMS`)] : []),
  ]).catch(error => console.error('[customer-refunds] notification delivery failed:', error?.message || error)));
  return res.status(201).json({
    ok: true, refundRecordId: refundRef.id, status: 'REQUESTED',
    message: 'Your refund request has been sent to HerStep for review. No money has been sent yet.',
  });
}
