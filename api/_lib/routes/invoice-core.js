// Invoice download + admin resend — replaceable core kept free of Vercel-only
// imports so scripts/test-invoices.mjs can run every branch against the strict
// in-memory fake Firestore (api/_lib/fake-firestore.js).
//
// Rules encoded here:
// - Amounts and items are read ONLY from Firestore (never from the client).
// - An invoice exists only once the order is PAID AND its payment is PAID;
//   anything else answers 409 "Your invoice is available once the payment is
//   confirmed."
// - Owner or admin only (non-owner gets 403).
// - Rate limits: 20 downloads per hour per user, 10 resends per hour per admin.
//   Counters live in server-only collection invoiceRateLimits/{id}.
// - The outbox record NEVER contains PDF bytes; it carries attachInvoiceFor and
//   deliverQueuedEmail builds the PDF at send time (retries stay safe).
import { FieldValue } from 'firebase-admin/firestore';
import { clientError } from '../http.js';
import { queueEmail, deliverQueuedEmailInline } from '../email-service.js';
import { invoiceEmail } from '../email-templates.js';
import { buildInvoicePdf } from '../invoice-pdf.js';
import { invoiceNumberFor } from '../invoice-number.js';

export const DOWNLOAD_LIMIT_PER_HOUR = 20;
export const RESEND_LIMIT_PER_HOUR = 10;
export const NOT_PAID_MESSAGE = 'Your invoice is available once the payment is confirmed.';

const millis = v => (v?.toDate ? v.toDate().getTime() : typeof v === 'number' ? v : v instanceof Date ? v.getTime() : null);

// Fixed-window hourly counter with a friendly retry message.
async function checkHourlyLimit(db, id, max, now, label) {
  const ref = db.collection('invoiceRateLimits').doc(id);
  const snap = await ref.get();
  const data = snap?.data?.() || null;
  const windowStart = millis(data?.windowStart);
  const fresh = windowStart == null || now - windowStart >= 3_600_000;
  const count = fresh ? 1 : (Number(data?.count) || 0) + 1;
  if (!fresh && count > max) {
    const secondsLeft = Math.max(1, Math.ceil((windowStart + 3_600_000 - now) / 1000));
    throw clientError(`Too many ${label} requests. Please try again in ${secondsLeft} seconds.`, 429);
  }
  await ref.set({ windowStart: fresh ? now : windowStart, count, updatedAt: now });
  return count;
}

async function loadPaidInvoiceSource(db, orderDocumentId) {
  const orderSnap = await db.collection('orders').doc(orderDocumentId).get();
  if (!orderSnap?.exists) throw clientError('Order not found.', 404);
  const order = { id: orderSnap.id, ...orderSnap.data() };
  const paymentSnap = order.paymentId
    ? await db.collection('payments').doc(order.paymentId).get()
    : null;
  const payment = paymentSnap?.exists ? { id: paymentSnap.id, ...paymentSnap.data() } : null;
  const paid = String(order.paymentStatus).toUpperCase() === 'PAID'
    && String(payment?.status).toUpperCase() === 'PAID';
  return { order, payment, paid };
}

// GET /api/invoices/download?orderDocumentId= (dispatched from api/orders.js).
// Returns { status, headers, body } so both the HTTP wrapper and the tests can
// assert on the exact response shape.
export async function downloadInvoiceCore({ db, auth, uid, token, orderDocumentId, now = Date.now() }) {
  const docId = String(orderDocumentId || '').trim();
  if (!docId) throw clientError('orderDocumentId is required.', 400);
  const isAdmin = Boolean(token?.admin === true || await isAdminUser(db, uid));
  const { order, payment, paid } = await loadPaidInvoiceSource(db, docId);
  if (!isAdmin && order.customerId !== uid) {
    throw clientError('You do not have access to this invoice.', 403);
  }
  if (!paid) throw clientError(NOT_PAID_MESSAGE, 409);
  await checkHourlyLimit(db, `DL-${uid}`, DOWNLOAD_LIMIT_PER_HOUR, now, 'invoice download');
  const invoiceNumber = order.invoiceNumber || invoiceNumberFor(order.orderId);
  // Amounts/items come straight from the Firestore document — nothing from the
  // request influences them. buildInvoicePdf is ASYNC: it MUST be awaited,
  // otherwise Buffer.from(<Promise>) throws a 500 on every download.
  const pdf = await buildInvoicePdf({ order, payment });
  return {
    status: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="HerStep-Invoice-${invoiceNumber}.pdf"`,
      'Cache-Control': 'private, no-store',
    },
    body: Buffer.from(pdf),
  };
}

// POST /api/admin/invoices/resend { orderDocumentId } (dispatched from api/admin.js).
// Resends ONLY the invoice email (never the payment-received receipt — that is
// a separate email queued by queuePaymentEmail with its own deterministic key).
// Returns { queued, sent, key } — "sent" reflects the best-effort delivery
// attempt right after queueing so the admin UI can say whether it actually
// went out or why it failed.
export async function resendInvoiceCore({ db, uid, orderDocumentId, now = Date.now() }) {
  const docId = String(orderDocumentId || '').trim();
  if (!docId) throw clientError('orderDocumentId is required.', 400);
  const { order, paid } = await loadPaidInvoiceSource(db, docId);
  if (!paid) throw clientError(NOT_PAID_MESSAGE, 409);
  await checkHourlyLimit(db, `RESEND-${uid}`, RESEND_LIMIT_PER_HOUR, now, 'invoice resend');
  const emailOrder = { ...order, id: docId };
  const { subject, htmlContent } = invoiceEmail(emailOrder);
  // Unique key per manual resend so an already-sent original is never reused;
  // attachInvoiceFor keeps the PDF OUT of the outbox document.
  const key = `${docId}-INVOICE-RESEND-${now}`;
  // queueEmail calls tx.set(...) — outside a transaction we hand it a tiny
  // adapter that buffers the writes like a WriteBatch, then commits them all.
  const writes = [];
  queueEmail({ set: (ref, data) => writes.push(ref.set(data)) }, db, {
    key,
    purpose: 'invoices',
    to: order.customerEmail,
    subject,
    htmlContent,
    attachInvoiceFor: docId,
  });
  writes.push(db.collection('auditLogs').doc().set({
    adminId: uid,
    action: 'INVOICE_RESENT',
    targetType: 'order',
    targetId: docId,
    orderDocumentId: docId,
    orderId: order.orderId || null,
    previous: null,
    next: 'RESEND',
    performedBy: uid,
    createdAt: FieldValue.serverTimestamp(),
  }));
  await Promise.all(writes);
  // Deliver right away (best-effort): the route wraps this in waitUntil via
  // try/catch inside deliverQueuedEmailInline, so a Brevo outage can never turn
  // the resend into a 500 — it just reports sent:false.
  const result = await deliverQueuedEmailInline(db, key);
  const sent = result?.sent === true;
  return {
    queued: true,
    sent,
    key,
    ...(sent ? {} : { reason: result?.error || (result?.skipped ? 'Email delivery is not configured on this deployment.' : 'The email could not be delivered.') }),
  };
}

// Roles are stored UPPERCASE in users/{uid}.role ("CUSTOMER" | "ADMIN" |
// "SUPER_ADMIN") — comparing against lowercase 'admin' meant admins were
// treated as non-admins and got 403/404 on invoice access.
async function isAdminUser(db, uid) {
  if (!uid) return false;
  const snap = await db.collection('users').doc(uid).get();
  const role = String(snap?.data?.()?.role || '').toUpperCase();
  return Boolean(snap?.exists) && (role === 'ADMIN' || role === 'SUPER_ADMIN');
}
