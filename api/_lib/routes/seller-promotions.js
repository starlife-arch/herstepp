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
      const ref = adminDb.collection('sellerPromotionPayments').doc(paymentId);
      const snap = await ref.get();
      if (!snap.exists) throw clientError('Promotion payment not found.', 404);
      let data = snap.data();
      if (data.sellerId !== user.uid) throw clientError('Forbidden.', 403);
      if (data.status === 'PENDING' && data.providerReference) {
        try {
          const result = await getMpesaProvider().checkStatus(data.providerReference);
          if (String(result.providerReference) === String(data.providerReference) && result.status !== 'PENDING') {
            await applyPromotionPayment(adminDb, { serverTimestamp: () => FieldValue.serverTimestamp() }, {
              providerReference: data.providerReference, status: result.status, amount: result.amount ?? data.amount,
              transactionReference: result.transactionReference, eventId: result.eventId || 'promotion-status:' + paymentId + ':' + result.status, reason: result.reason || null });
          }
        } catch (error) { console.error('seller promotion status reconciliation failed:', error?.message || error); }
        const refreshed = await ref.get(); if (refreshed.exists) data = refreshed.data();
      }
      return res.json({ payment: publicPayment(paymentId, data) });
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
  const productId = String(req.body?.productId || '').trim();
  const phone = String(req.body?.phone || '').trim();
  const idempotencyKey = String(req.body?.idempotencyKey || '').trim();
  if (!/^[A-Za-z0-9_-]{8,150}$/.test(productId)) throw clientError('Choose a valid product to promote.');
  if (!/^[A-Za-z0-9_-]{12,100}$/.test(idempotencyKey)) throw clientError('A valid idempotency key is required.');
  const paymentId = paymentIdFor(user.uid, idempotencyKey);
  const paymentRef = adminDb.collection('sellerPromotionPayments').doc(paymentId);
  const existing = await paymentRef.get();
  if (existing.exists) {
    const data = existing.data();
    if (data.sellerId !== user.uid || data.productId !== productId || data.phone !== phone) throw clientError('This idempotency key was already used for another request.', 409);
    if (data.providerReference) return res.status(202).json({ payment: publicPayment(paymentId, data), reused: true });
    throw clientError('This payment request is already being prepared. Check its status before retrying.', 409);
  }
  const productRef = adminDb.collection('products').doc(productId);
  const productSnap = await productRef.get();
  if (!productSnap.exists || productSnap.data()?.sellerUid !== user.uid || String(productSnap.data()?.status || '').toUpperCase() !== 'ACTIVE') throw clientError('Only your active marketplace products can be promoted.', 403);
  const phoneDigits = phone.replace(/[\s()+-]/g, '');
  if (!/^(?:254[17]\d{8}|0[17]\d{8})$/.test(phoneDigits)) throw clientError('Enter a valid Kenyan M-Pesa phone number.');
  await paymentRef.create({ paymentId, sellerId: user.uid, ownerUid: user.uid, productId, phone: phoneDigits, amount: PROMOTION_PRICE, currency: 'KES',
    method: 'MPESA', status: 'PENDING', providerReference: null, transactionReference: null, idempotencyKey,
    createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  try {
    const stk = await getMpesaProvider().initiateStk({ phone: phoneDigits, amount: PROMOTION_PRICE });
    await paymentRef.update({ providerReference: stk.providerReference, updatedAt: FieldValue.serverTimestamp() });
    return res.status(202).json({ payment: { paymentId, productId, status: 'PENDING', amount: PROMOTION_PRICE, currency: 'KES', providerReference: stk.providerReference } });
  } catch (error) { await paymentRef.update({ initiationError: true, updatedAt: FieldValue.serverTimestamp() }).catch(() => {}); throw error; }
}
