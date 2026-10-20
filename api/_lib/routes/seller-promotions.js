import { createHash } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { adminDb, requireUser } from '../firebase-admin.js';
import { getMpesaProvider } from '../mpesa-provider.js';
import { clientError, methodNotAllowed } from '../http.js';

const PROMOTION_PRICE = 100;
const PROMOTION_DAYS = 7;
const TERMINAL = new Set(['PAID', 'FAILED', 'CANCELLED', 'TIMEOUT']);
function dateValue(value) {
  if (value?.toDate) return value.toDate();
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') { const d = new Date(value); return Number.isNaN(d.getTime()) ? null : d; }
  return null;
}
function paymentIdFor(uid, key) { return createHash('sha256').update('marketplace-promotion:' + uid + ':' + key).digest('hex'); }
function publicPayment(id, data) {
  return { paymentId: id, productId: data.productId, status: data.status, amount: data.amount, currency: 'KES',
    providerReference: data.providerReference || null, transactionReference: data.transactionReference || null,
    failureReason: data.failureReason || null, promotedUntil: data.promotedUntil || null };
}
export async function applyPromotionPayment(db, deps, input) {
  const providerReference = String(input?.providerReference || '');
  const status = String(input?.status || '').toUpperCase();
  if (!providerReference || !['PAID', 'FAILED', 'CANCELLED', 'TIMEOUT', 'PENDING'].includes(status)) throw clientError('Promotion payment result is invalid.');
  const matches = await db.collection('sellerPromotionPayments').where('providerReference', '==', providerReference).limit(1).get();
  if (matches.empty) return { applied: false, unknown: true };
  const paymentRef = matches.docs[0].ref;
  return db.runTransaction(async tx => {
    const snap = await tx.get(paymentRef);
    if (!snap.exists) return { applied: false, unknown: true };
    const payment = snap.data();
    if (payment.status === 'PAID') return { applied: false, duplicate: true };
    if (TERMINAL.has(payment.status) && status !== 'PAID') return { applied: false, duplicate: true };
    if (status === 'PAID' && (Number(input.amount) !== PROMOTION_PRICE || Number(payment.amount) !== PROMOTION_PRICE)) throw clientError('Promotion payment amount does not match the required KSh 100.', 409);
    const patch = { status, transactionReference: input.transactionReference || null,
      failureReason: status === 'PAID' ? null : (input.reason || status), updatedAt: deps.serverTimestamp(),
      completedAt: status === 'PENDING' ? null : deps.serverTimestamp(), providerEventId: input.eventId || null };
    if (status === 'PAID') {
      const productRef = db.collection('products').doc(payment.productId);
      const productSnap = await tx.get(productRef);
      if (!productSnap.exists || productSnap.data()?.sellerUid !== payment.sellerId) {
        patch.status = 'PAID'; patch.promotionIssue = 'Product no longer exists or seller ownership changed; contact support.';
      } else {
        const until = new Date(Date.now() + PROMOTION_DAYS * 24 * 60 * 60 * 1000);
        patch.promotedUntil = until.toISOString();
        tx.update(productRef, { promotedUntil: until, promotedPaymentId: paymentRef.id, promotedAt: deps.serverTimestamp(), updatedAt: deps.serverTimestamp() });
      }
    }
    tx.update(paymentRef, patch);
    return { applied: true, status: patch.status, promotedUntil: patch.promotedUntil || null };
  });
}
// Core of the GET ?paymentId= handler: surface the payment and, while it is
// still PENDING, reconcile against PrintPay so a missed webhook or a checkout
// that expired without an STK push never leaves the seller staring at
// "PENDING" forever. Exported for unit testing with an injected db/provider.
export async function reconcilePromotionPayment(db, provider, uid, paymentId) {
  const ref = db.collection('sellerPromotionPayments').doc(paymentId);
  const snap = await ref.get();
  if (!snap.exists) throw clientError('Promotion payment not found.', 404);
  let data = snap.data();
  if (data.sellerId !== uid) throw clientError('Forbidden.', 403);
  // A stuck PENDING row with NO providerReference means the STK push never
  // reached PrintPay (crash/network blip mid-initiation). It can never be
  // paid — expire it so the seller's next click starts a fresh prompt
  // instead of being blocked by this dead record.
  const startedAt = dateValue(data.createdAt || data.updatedAt);
  if (data.status === 'PENDING' && !data.providerReference && (!startedAt || Date.now() - startedAt.getTime() > 5 * 60 * 1000)) {
    const patch = { status: 'TIMEOUT', failureReason: 'The M-Pesa prompt could not be delivered. Please try again.', completedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() };
    await ref.update(patch).catch(() => {});
    data = { ...data, ...patch };
  } else if (data.status === 'PENDING' && data.providerReference) {
    try {
      const result = await provider.checkStatus(data.providerReference);
      if (String(result.providerReference) === String(data.providerReference) && result.status !== 'PENDING') {
        await applyPromotionPayment(db, { serverTimestamp: () => FieldValue.serverTimestamp() }, {
          providerReference: data.providerReference, status: result.status, amount: result.amount ?? data.amount,
          transactionReference: result.transactionReference, eventId: result.eventId || 'promotion-status:' + paymentId + ':' + result.status, reason: result.reason || null });
      }
    } catch (error) { console.error('seller promotion status reconciliation failed:', error?.message || error); }
    const refreshed = await ref.get(); if (refreshed.exists) data = refreshed.data();
  }
  return publicPayment(paymentId, data);
}

// Core of the POST handler: create-or-reuse the payment record, then fire the
// STK push. Reuses any still-PENDING checkout for the same seller/product/
// phone (so retries after a failed prompt actually send a new STK instead of
// returning the old dead one), and cleans up the local PENDING row when the
// provider rejects the request so nothing gets stuck. Exported for testing.
export async function startPromotionPayment(db, provider, uid, body) {
  const productId = String(body?.productId || '').trim();
  const phone = String(body?.phone || '').trim();
  const idempotencyKey = String(body?.idempotencyKey || '').trim();
  if (!/^[A-Za-z0-9_-]{8,150}$/.test(productId)) throw clientError('Choose a valid product to promote.');
  if (!/^[A-Za-z0-9_-]{12,100}$/.test(idempotencyKey)) throw clientError('A valid idempotency key is required.');
  const phoneDigits = phone.replace(/[\s()+-]/g, '');
  if (!/^(?:254[17]\d{8}|0[17]\d{8})$/.test(phoneDigits)) throw clientError('Enter a valid Kenyan M-Pesa phone number.');
  const paymentId = paymentIdFor(uid, idempotencyKey);
  const paymentRef = db.collection('sellerPromotionPayments').doc(paymentId);
  const existing = await paymentRef.get();
  if (existing.exists) {
    const data = existing.data();
    if (data.sellerId !== uid || data.productId !== productId || data.phone !== phoneDigits) throw clientError('This idempotency key was already used for another request.', 409);
    if (data.status === 'PAID') return { statusCode: 202, body: { payment: publicPayment(paymentId, data), reused: true } };
    if (data.status === 'PENDING' && data.providerReference) return { statusCode: 202, body: { payment: publicPayment(paymentId, data), reused: true } };
    // Terminal (FAILED/CANCELLED/TIMEOUT) or a stuck PENDING with no checkout:
    // this exact key is spent — the caller must retry with a fresh key.
    if (data.status !== 'PENDING') throw clientError('This payment request already ended (' + data.status + '). Start a new promotion prompt to try again.', 409);
    await paymentRef.delete().catch(() => {});
  }
  // Reuse any earlier abandoned attempt for the SAME seller/product/phone:
  // if its checkout is still live on PrintPay, re-show that prompt instead of
  // double-charging; otherwise settle it with the provider and start a
  // brand-new STK push. Single-field query (no composite index required).
  const prior = await db.collection('sellerPromotionPayments')
    .where('sellerId', '==', uid).limit(50).get().catch(() => null);
  for (const doc of prior?.docs || []) {
    const p = doc.data();
    if (p.productId !== productId || p.phone !== phoneDigits) continue;
    if (!['PENDING', 'FAILED', 'CANCELLED', 'TIMEOUT'].includes(p.status)) continue;
    if (!p.providerReference) continue;
    try {
      const st = await provider.checkStatus(p.providerReference);
      if (st.status === 'PENDING' && String(st.providerReference) === String(p.providerReference)) {
        await doc.ref.update({ idempotencyKey, updatedAt: FieldValue.serverTimestamp() }).catch(() => {});
        return { statusCode: 202, body: { payment: publicPayment(doc.id, { ...p, idempotencyKey }), reused: true } };
      }
      if (st.status !== 'PENDING' && p.status === 'PENDING') {
        await applyPromotionPayment(db, { serverTimestamp: () => FieldValue.serverTimestamp() }, {
          providerReference: p.providerReference, status: st.status, amount: st.amount ?? p.amount,
          transactionReference: st.transactionReference, eventId: st.eventId || 'promotion-reuse:' + doc.id + ':' + st.status, reason: st.reason || null }).catch(() => {});
      }
    } catch { /* provider unreachable — fall through and open a new checkout */ }
  }
  const productRef = db.collection('products').doc(productId);
  const productSnap = await productRef.get();
  if (!productSnap.exists || productSnap.data()?.sellerUid !== uid || String(productSnap.data()?.status || '').toUpperCase() !== 'ACTIVE') throw clientError('Only your active marketplace products can be promoted.', 403);
  await paymentRef.set({ paymentId, sellerId: uid, ownerUid: uid, productId, phone: phoneDigits, amount: PROMOTION_PRICE, currency: 'KES',
    method: 'MPESA', status: 'PENDING', providerReference: null, transactionReference: null, failureReason: null, idempotencyKey,
    createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), initiatedAt: FieldValue.serverTimestamp() });
  try {
    const stk = await provider.initiateStk({ phone: phoneDigits, amount: PROMOTION_PRICE });
    await paymentRef.update({ providerReference: stk.providerReference, updatedAt: FieldValue.serverTimestamp() });
    return { statusCode: 202, body: { payment: { paymentId, productId, status: 'PENDING', amount: PROMOTION_PRICE, currency: 'KES', providerReference: stk.providerReference } } };
  } catch (error) {
    // The STK push never reached the phone — don't leave a PENDING ghost that
    // blocks retries. Expire the row locally so the next attempt starts clean.
    await paymentRef.update({ status: 'FAILED', providerReference: null, failureReason: 'The M-Pesa prompt could not be sent. Please try again.',
      completedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() }).catch(() => {});
    throw error;
  }
}

export default async function sellerPromotions(req, res) {
  const user = await requireUser(req);
  const sellerRef = adminDb.collection('sellers').doc(user.uid);
  const sellerSnap = await sellerRef.get();
  if (!sellerSnap.exists || sellerSnap.data()?.ownerUid !== user.uid || sellerSnap.data()?.status !== 'ACTIVE') throw clientError('An approved, active seller account is required.', 403);
  const seller = sellerSnap.data();
  const expiry = dateValue(seller.subscriptionExpiresAt);
  if (req.method === 'GET') {
    const paymentId = Array.isArray(req.query.paymentId) ? req.query.paymentId[0] : req.query.paymentId;
    if (paymentId) {
      if (typeof paymentId !== 'string' || !/^[a-f0-9]{64}$/.test(paymentId)) throw clientError('Promotion payment id is invalid.');
      const payment = await reconcilePromotionPayment(adminDb, getMpesaProvider(), user.uid, paymentId);
      return res.json({ payment });
    }
    if (seller.billingStatus !== 'ACTIVE' || !expiry || expiry.getTime() <= Date.now()) throw clientError('An active seller subscription is required to promote products.', 403);
    const products = await adminDb.collection('products').where('sellerUid', '==', user.uid).limit(200).get();
    return res.json({ products: products.docs.filter(d => String(d.data()?.status || '').toUpperCase() === 'ACTIVE').map(d => {
      const p = d.data(); const until = dateValue(p.promotedUntil);
      return { id: d.id, name: String(p.name || 'Product'), promotedUntil: until && until.getTime() > Date.now() ? until.toISOString() : null };
    }) });
  }
  if (req.method !== 'POST') return methodNotAllowed(res, 'GET, POST');
  if (seller.billingStatus !== 'ACTIVE' || !expiry || expiry.getTime() <= Date.now()) throw clientError('An active seller subscription is required to promote products.', 403);
  const result = await startPromotionPayment(adminDb, getMpesaProvider(), user.uid, req.body);
  return res.status(result.statusCode).json(result.body);
}
