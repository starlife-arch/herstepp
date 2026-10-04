// Notification hooks — the single place that turns business events into
// queued emails (inside the SAME Firestore transaction as the event) and
// best-effort Telegram messages (after commit). NOTHING here may ever throw
// into checkout / payments / signup: every helper is wrapped.
import { FieldValue } from 'firebase-admin/firestore';
import { queueEmail, deliverQueuedEmailInline } from './email-service.js';
import { sendTelegramMessage } from './telegram.js';
import { buildEmail, orderReceiptEmail, escapeHtml } from './email-templates.js';

const money = n => `KSh ${(Number(n) || 0).toLocaleString('en-KE')}`;

// ---- Queue helpers (run INSIDE a transaction; never break the tx on bad data)
export function queueWelcomeEmail(tx, db, { uid, email, displayName }) {
  try {
    if (!email) return; // no address -> nothing to queue, silently
    const { subject, htmlContent } = buildEmail(
      'Welcome to HerStep Collection',
      `Hi ${displayName || 'there'},\n\nWelcome to HerStep Collection — Step Into Your Style.\nYour account is ready. Browse our latest heels, boots and sneakers any time, and pay conveniently with M-Pesa.\n\nCollection is always available at Juja Town, Jerry House, near Juja Posta, Outside Shop No. 12.`,
      { ctaLabel: 'Start shopping', ctaUrl: `${(globalThis.process?.env || {}).SITE_URL || 'https://herstepp.vercel.app'}/shop` },
    );
    queueEmail(tx, db, { key: `${uid}-WELCOME`, purpose: 'hello', to: email, subject, htmlContent });
  } catch (error) {
    console.error('[notify] queueWelcomeEmail failed:', error?.message || error);
  }
}

// Read pass for the welcome email + admin Telegram ping: only when this call
// CREATES users/{uid} for the first time. Never throws.
export async function maybeQueueWelcome(db, userRef, { uid, email, displayName }) {
  try {
    await db.runTransaction(async tx => {
      const snap = await tx.get(userRef);
      if (snap.exists) return; // not a first sign-up
      tx.set(userRef, {
        uid,
        email: email || '',
        displayName: displayName || '',
        welcomeQueuedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      queueWelcomeEmail(tx, db, { uid, email, displayName });
    });
  } catch (error) {
    console.error('[notify] maybeQueueWelcome failed:', error?.message || error);
  }
}

// Order created: Telegram only (the customer gets an email once PAID or when
// the payment attempt dies — not for an unpaid basket).
export function telegramNewOrder(order) {
  const items = Array.isArray(order.items) ? order.items.reduce((s, i) => s + (Number(i.quantity) || 0), 0) : 0;
  return sendTelegramMessage(
    `New order ${order.orderId}: ${money(order.total)} · ${items} item(s) · ${order.customerName || order.delivery?.fullName || 'unknown'}`,
  ).catch(() => false);
}

// Payment result (PAID / FAILED / CANCELLED / TIMEOUT): queue the email inside
// applyVerifiedCallbackCore's transaction, then send after commit.
export function queuePaymentEmail(tx, db, { orderDocumentId, order, status, failureReason, receiptNumber }) {
  try {
    if (!order?.customerEmail) return;
    const st = String(status).toUpperCase();
    const emailOrder = {
      ...order,
      id: orderDocumentId,
      failureReason: failureReason ?? order.failureReason ?? null,
      receiptNumber: receiptNumber ?? order.receiptNumber ?? null,
    };
    const { subject, htmlContent } = orderReceiptEmail(emailOrder, st);
    queueEmail(tx, db, { key: `${orderDocumentId}-PAYMENT-${st}`, purpose: 'payments', to: order.customerEmail, subject, htmlContent });
  } catch (error) {
    console.error('[notify] queuePaymentEmail failed:', error?.message || error);
  }
}

export function telegramPayment(status, order, payment) {
  const st = String(status).toUpperCase();
  const name = order?.customerName || order?.delivery?.fullName || 'unknown';
  const phone = payment?.phone || order?.delivery?.phone || '';
  const amount = payment?.amount ?? order?.total;
  let text;
  if (st === 'PAID') {
    text = `Payment confirmed ${order?.orderId}: ${money(amount)} · ${name} · ${phone}`;
  } else {
    text = `Payment ${st} ${order?.orderId}: ${money(amount)} · ${payment?.failureReason || order?.failureReason || 'no reason given'}`;
  }
  return sendTelegramMessage(text).catch(() => false);
}

// Order status changes (PROCESSING / PROCESSED / OUT_FOR_DELIVERY / DELIVERED /
// CANCELLED): one friendly line per status, deterministic key per status.
const ORDER_STATUS_LINES = {
  PROCESSING: 'Good news — your order is now being prepared. We will let you know when it is on its way.',
  PROCESSED: 'Your order has been packed and is almost ready to move.',
  OUT_FOR_DELIVERY: 'Your order is out for delivery! Keep your phone handy.',
  DELIVERED: 'Your order has been delivered. Thank you for shopping with HerStep Collection — we hope you love your new steps!',
  CANCELLED: 'Your order was cancelled. If this was unexpected, contact support and we will help you right away.',
};

export function queueOrderStatusEmail(tx, db, { orderDocumentId, order, orderStatus }) {
  try {
    const st = String(orderStatus).toUpperCase();
    const line = ORDER_STATUS_LINES[st];
    if (!line || !order?.customerEmail) return;
    const { subject, htmlContent } = buildEmail(
      `Order ${order.orderId} — ${st.replace(/_/g, ' ').toLowerCase()}`,
      `Hi ${order.delivery?.fullName || order.customerName || 'there'},\n\n${line}`,
      { ctaLabel: 'View your order', ctaUrl: `${(globalThis.process?.env || {}).SITE_URL || 'https://herstepp.vercel.app'}/dashboard` },
    );
    queueEmail(tx, db, { key: `${orderDocumentId}-ORDER-${st}`, purpose: 'orders', to: order.customerEmail, subject, htmlContent });
  } catch (error) {
    console.error('[notify] queueOrderStatusEmail failed:', error?.message || error);
  }
}

// Low stock alert: fired when an order leaves any size of a product at <= 2.
// "Once per product+size+quantity value" is enforced by a marker doc under
// notifications/ (server-written collection, already allowed by rules) so the
// same warning never spams Telegram twice.
export async function telegramLowStock(db, changes) {
  try {
    for (const c of changes || []) {
      if (!(c.newQuantity <= 2 && c.previousQuantity > c.newQuantity)) continue;
      const markerId = `LOWSTOCK-${escapeHtml(String(c.productId))}-${c.size}-${c.newQuantity}`.replace(/[^A-Za-z0-9_-]/g, '_');
      const markerRef = db.collection('notifications').doc(markerId);
      const existing = await markerRef.get();
      if (existing.exists) continue; // already alerted for this product+size+qty
      await markerRef.set({
        customerId: '__ADMIN__',
        event: 'LOW_STOCK',
        title: 'Low stock',
        body: `${c.productName || c.productId} size ${c.size} has ${c.newQuantity} left`,
        readAt: null,
        createdAt: FieldValue.serverTimestamp(),
      }).catch(() => {});
      await sendTelegramMessage(`Low stock: ${c.productName || c.productId} size ${c.size} has ${c.newQuantity} left`).catch(() => false);
    }
  } catch (error) {
    console.error('[notify] telegramLowStock failed:', error?.message || error);
  }
}

// ---- Tips (in-app tipping) --------------------------------------------------
// Thank-you email queued INSIDE the tip PAID transaction (deterministic key
// <tipId>-TIP-THANKYOU means a replayed webhook/poll can never double-send).
export function queueTipThankYouEmail(tx, db, { key, tip, receiptNumber }) {
  try {
    if (!tip?.customerEmail) return;
    const label = tip.treatLabel || tip.treat || 'tip';
    const { subject, htmlContent } = buildEmail(
      'Thank you for treating the HerStep team!',
      `Hi ${tip.customerName || 'there'},\n\nYour KSh ${(Number(tip.amount) || 0).toLocaleString('en-KE')} ${label} just made the whole team smile. Thank you so much for supporting HerStep Collection!\n\nReceipt: ${receiptNumber || '—'}${tip.message ? `\n\nYour message: "${tip.message}"` : ''}\n\nWith gratitude,\nThe HerStep team`,
      { ctaLabel: 'Shop with us', ctaUrl: `${(globalThis.process?.env || {}).SITE_URL || 'https://herstepp.vercel.app'}/shop` },
    );
    queueEmail(tx, db, { key, purpose: 'payments', to: tip.customerEmail, subject, htmlContent });
  } catch (error) {
    console.error('[notify] queueTipThankYouEmail failed:', error?.message || error);
  }
}

// Admin Telegram ping when a tip lands. Best-effort — NEVER affects orders or
// the payment flow; returns a promise that always resolves.
export function telegramTipReceived(tip) {
  try {
    const amount = `KSh ${(Number(tip?.amount) || 0).toLocaleString('en-KE')}`;
    const label = tip?.treatLabel || tip?.treat || 'Tip';
    const name = tip?.customerName || 'a customer';
    const message = tip?.message ? ` · ${tip.message}` : '';
    return sendTelegramMessage(`Tip received: ${amount} · ${label} · ${name}${message}`).catch(() => false);
  } catch (error) {
    console.error('[notify] telegramTipReceived failed:', error?.message || error);
    return Promise.resolve(false);
  }
}

// Fire-and-forget delivery of a just-queued email. MUST be passed to
// waitUntil() in routes; never awaited on the response path, never throws.
// Returns the (already error-swallowed) promise so callers can hand it to
// waitUntil and keep it alive after the HTTP response is sent.
export function deliverEmailAfterCommit(db, key) {
  return deliverQueuedEmailInline(db, key).catch(error => {
    console.error(`[notify] post-commit email delivery failed for ${key}:`, error?.message || error);
  });
}
