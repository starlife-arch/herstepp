import { createHash } from 'node:crypto';
import { clientError } from './http.js';

export const SELLER_PLANS = Object.freeze({
  STARTER: Object.freeze({ amount: 150, productLimit: 20 }),
  STANDARD: Object.freeze({ amount: 350, productLimit: 100 }),
  GROWTH: Object.freeze({ amount: 800, productLimit: 1000 }),
  UNLIMITED: Object.freeze({ amount: 1500, productLimit: null }),
});
export const SELLER_BADGE_MONTHLY_FEE = 50;

export function sellerSubscriptionPaymentId(uid, idempotencyKey) {
  return createHash('sha256').update(String(uid) + ':' + String(idempotencyKey)).digest('hex');
}

export function normalizeSellerPhone(value) {
  const digits = String(value ?? '').replace(/[\s()-]/g, '');
  if (/^0[17]\d{8}$/.test(digits)) return '+254' + digits.slice(1);
  if (/^254[17]\d{8}$/.test(digits)) return '+' + digits;
  if (/^\+254[17]\d{8}$/.test(digits)) return digits;
  throw clientError('Enter a valid Kenyan M-Pesa number.');
}

export async function findSellerSubscriptionPaymentByProviderReference(db, providerReference) {
  const snap = await db.collection('sellerSubscriptionPayments')
    .where('providerReference', '==', providerReference).limit(1).get();
  return snap.empty ? null : { id: snap.docs[0].id, ...snap.docs[0].data() };
}

export async function applySellerSubscriptionPayment(db, deps, callback) {
  const { providerReference, status, amount, transactionReference = null, eventId, reason = null, source = 'PRINTPAY' } = callback || {};
  if (!providerReference || !eventId) throw clientError('Missing subscription payment reference.', 400);
  if (!['PAID', 'FAILED', 'CANCELLED', 'TIMEOUT'].includes(status)) throw clientError('Unknown subscription payment status.', 400);
  const eventIdSafe = createHash('sha256').update(String(eventId)).digest('hex');
  const eventRef = db.collection('sellerSubscriptionPaymentEvents').doc(eventIdSafe);
  return db.runTransaction(async tx => {
    const eventSnap = await tx.get(eventRef);
    if (eventSnap.exists) return { duplicate: true, status: eventSnap.data()?.appliedStatus || status };
    const paymentQuery = await tx.get(db.collection('sellerSubscriptionPayments').where('providerReference', '==', providerReference).limit(1));
    if (paymentQuery.empty) throw clientError('Seller subscription payment not found.', 404);
    const paymentDoc = paymentQuery.docs[0];
    const paymentRef = paymentDoc.ref;
    const payment = paymentDoc.data();
    const sellerRef = db.collection('sellers').doc(payment.sellerId);
    const sellerSnap = await tx.get(sellerRef);
    if (!sellerSnap.exists) throw clientError('Seller account not found.', 404);
    const paidAmount = Number(amount);
    if (!Number.isFinite(paidAmount) || paidAmount !== Number(payment.amount)) {
      throw clientError('The subscription payment amount does not match.', 409);
    }
    if (payment.status === 'PAID') {
      tx.set(eventRef, { paymentId: paymentRef.id, providerReference, appliedStatus: 'PAID', duplicate: true, source, createdAt: deps.serverTimestamp() });
      return { duplicate: true, status: 'PAID' };
    }
    if (['FAILED', 'CANCELLED', 'TIMEOUT'].includes(payment.status) && status !== 'PAID') {
      tx.set(eventRef, { paymentId: paymentRef.id, providerReference, appliedStatus: payment.status, duplicate: true, source, createdAt: deps.serverTimestamp() });
      return { duplicate: true, status: payment.status };
    }
    if (status === 'PAID') {
      const plan = SELLER_PLANS[payment.planCode];
      const months = Number(payment.durationMonths || 1);
      const discountPercent = months === 1 ? 0 : Number(payment.discountPercent || 0);
      const planSubtotal = plan ? plan.amount * months : 0;
      const discountAmount = Math.round(planSubtotal * discountPercent / 100);
      const badgeAmount = SELLER_BADGE_MONTHLY_FEE * months;
      const expectedAmount = planSubtotal - discountAmount + badgeAmount;
      if (!plan || ![1, 3, 6, 12].includes(months) || Number(payment.planAmount) !== plan.amount || Number(payment.badgeAmount) !== badgeAmount || Number(payment.discountAmount || 0) !== discountAmount || Number(payment.amount) !== expectedAmount || discountPercent < 0 || discountPercent > 50) throw clientError('Seller subscription pricing failed validation.', 409);
      const now = new Date();
      const periodEnd = new Date(now);
      periodEnd.setMonth(periodEnd.getMonth() + months);
      const subscriptionRef = db.collection('sellerSubscriptions').doc(paymentRef.id);
      tx.set(subscriptionRef, {
        sellerId: payment.sellerId,
        ownerUid: payment.ownerUid,
        planCode: payment.planCode,
        planAmount: plan.amount,
        durationMonths: months,
        planSubtotal,
        discountPercent,
        discountAmount,
        discountedPlanAmount: planSubtotal - discountAmount,
        badgeAmount,
        amount: expectedAmount,
        currency: 'KES',
        status: 'ACTIVE',
        productLimit: plan.productLimit,
        periodStart: now,
        periodEnd,
        paymentId: paymentRef.id,
        providerReference,
        transactionReference: transactionReference || null,
        createdAt: deps.serverTimestamp(),
        updatedAt: deps.serverTimestamp(),
      }, { merge: true });
      tx.update(sellerRef, {
        planCode: payment.planCode,
        productLimit: plan.productLimit,
        planAmount: plan.amount,
        subscriptionDurationMonths: months,
        subscriptionDiscountPercent: discountPercent,
        billingStatus: 'ACTIVE',
        subscriptionId: paymentRef.id,
        subscriptionExpiresAt: periodEnd,
        badgeSubscriptionStatus: 'ACTIVE',
        badgeSubscriptionExpiresAt: periodEnd,
        // The verified-business badge is part of EVERY paid plan (the 50 KES
        // badge fee is mandatory in the checkout total), so paying turns it on
        // automatically — no manual admin "Verify business" click needed.
        // Admins can still revoke the badge explicitly; revocation persists
        // only while the paid badge subscription lapses, and any new payment
        // re-grants it.
        verificationBadge: true,
        verificationBadgeGrantedBy: 'SUBSCRIPTION_PAYMENT',
        updatedAt: deps.serverTimestamp(),
      });
      tx.set(db.collection('sellerMarketplaceAudit').doc(), {
        action: 'SUBSCRIPTION_PAYMENT_CONFIRMED',
        sellerId: payment.sellerId,
        actorUid: 'SYSTEM',
        paymentId: paymentRef.id,
        planCode: payment.planCode,
        amount: paidAmount,
        providerReference,
        transactionReference: transactionReference || null,
        createdAt: deps.serverTimestamp(),
      });
    }
    tx.update(paymentRef, {
      status,
      transactionReference: transactionReference || payment.transactionReference || null,
      failureReason: status === 'PAID' ? null : (reason || 'The subscription payment was not completed.'),
      completedAt: deps.serverTimestamp(),
      updatedAt: deps.serverTimestamp(),
    });
    tx.set(eventRef, {
      paymentId: paymentRef.id,
      providerReference,
      appliedStatus: status,
      amount: paidAmount,
      transactionReference: transactionReference || null,
      source,
      createdAt: deps.serverTimestamp(),
    });
    return { duplicate: false, status, paymentId: paymentRef.id, sellerId: payment.sellerId };
  });
}
