import { createHash } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { adminDb, requireUser } from '../firebase-admin.js';
import { getMpesaProvider } from '../mpesa-provider.js';
import { clientError, methodNotAllowed } from '../http.js';
import { SELLER_PLANS, SELLER_BADGE_MONTHLY_FEE, normalizeSellerPhone, sellerSubscriptionPaymentId, applySellerSubscriptionPayment } from '../seller-subscription-core.js';
import { RECONCILE_TIMEOUT_MS } from '../order-core.js';
import { calculateSellerSubscriptionPrice, DEFAULT_SELLER_TERM_DISCOUNTS } from '../seller-subscription-pricing.js';

export default async function sellerSubscription(req, res) {
  const user = await requireUser(req);
  if (req.method === 'POST') {
    const action = String(req.body?.action || '').trim().toUpperCase();
    if (action === 'REDEEM_REWARDS') {
      const planCode = String(req.body?.planCode || '').trim().toUpperCase();
      const plan = SELLER_PLANS[planCode];
      if (!plan) throw clientError('Choose a valid seller subscription plan.');
      const idempotencyKey = String(req.body?.idempotencyKey || '').trim();
      if (!/^[A-Za-z0-9_-]{12,100}$/.test(idempotencyKey)) throw clientError('A valid idempotency key is required.');
      const paymentId = sellerSubscriptionPaymentId(user.uid, 'rewards:' + idempotencyKey);
      const paymentRef = adminDb.collection('sellerSubscriptionPayments').doc(paymentId);
      const sellerRef = adminDb.collection('sellers').doc(user.uid);
      const rewardAccountRef = adminDb.collection('rewardAccounts').doc(user.uid);
      const configRef = adminDb.collection('rewardsConfig').doc('current');
      const rewardRef = adminDb.collection('rewardLedger').doc(paymentId);
      const result = await adminDb.runTransaction(async tx => {
        const [existingSnap, sellerFresh, configSnap, userLedger, allLedger, rewardAccountSnap] = await Promise.all([
          tx.get(paymentRef), tx.get(sellerRef), tx.get(configRef),
          tx.get(adminDb.collection('rewardLedger').where('uid', '==', user.uid)),
          tx.get(adminDb.collection('rewardLedger').where('status', '==', 'POSTED')),
          tx.get(rewardAccountRef),
        ]);
        if (existingSnap.exists) {
          const existing = existingSnap.data() || {};
          if (existing.planCode !== planCode || existing.method !== 'REWARDS') throw clientError('This redemption key was already used for a different request.', 409);
          return { duplicate: true, paymentId, status: existing.status, amount: existing.amount, planCode };
        }
        const currentSeller = sellerFresh.data() || {};
        if (!sellerFresh.exists || currentSeller.ownerUid !== user.uid || currentSeller.status !== 'ACTIVE') throw clientError('An approved, active seller account is required.', 403);
        const config = configSnap.data() || {};
        if (config.enabled !== true || config.seller?.enabled === false || config.seller?.redemptionEnabled !== true || !Array.isArray(config.seller?.redemptionTargets) || !config.seller.redemptionTargets.includes('SELLER_PLAN')) throw clientError('Seller plan reward redemption is not enabled by the administrator.');
        const amount = plan.amount + SELLER_BADGE_MONTHLY_FEE;
        const pointValue = Math.max(0.001, Number(config.pointValueKes) || 0.1);
        const points = Math.ceil(amount / pointValue);
        const minPoints = Math.max(1, Math.floor(Number(config.seller?.minRedeemPoints) || 100));
        if (points < minPoints || Math.abs(points * pointValue - amount) > 0.000001) throw clientError('This plan cannot be paid exactly with the current reward-point conversion.');
        const nowMs = Date.now();
        const balance = userLedger.docs.reduce((sum, doc) => {
          const e = doc.data() || {}; if (String(e.status || 'POSTED').toUpperCase() !== 'POSTED') return sum;
          const expires = e.expiresAt?.toMillis?.() ?? e.expiresAt?.toDate?.()?.getTime?.() ?? (e.expiresAt instanceof Date ? e.expiresAt.getTime() : null);
          const p = Number(e.points) || 0; if (p > 0 && expires != null && expires <= nowMs) return sum; return sum + p;
        }, 0);
        if (balance < points) throw clientError(`You need ${points} available reward points to pay for this plan and badge.`, 409);
        const now = new Date(); const periodEnd = new Date(now); periodEnd.setMonth(periodEnd.getMonth() + 1);
        const timestamp = FieldValue.serverTimestamp();
        const rewardAccount = rewardAccountSnap.data() || {};
        tx.set(rewardAccountRef, { pointsBalance: Math.max(0, Number(rewardAccount.pointsBalance || 0) - points), updatedAt: timestamp }, { merge: true });
        tx.create(paymentRef, { paymentId, sellerId: user.uid, ownerUid: user.uid, planCode, planAmount: plan.amount, badgeAmount: SELLER_BADGE_MONTHLY_FEE, amount, currency: 'KES', method: 'REWARDS', status: 'PAID', providerReference: null, transactionReference: null, failureReason: null, idempotencyKey, rewardPointsRedeemed: points, createdAt: timestamp, updatedAt: timestamp, completedAt: timestamp });
        tx.create(rewardRef, { uid: user.uid, accountType: 'SELLER', type: 'REDEEM', points: -points, amountKes: amount, reason: 'Redeemed reward points for seller plan and verified-business badge', status: 'POSTED', idempotencyKey: paymentId, target: 'SELLER_PLAN', paymentId, createdAt: timestamp });
        tx.set(adminDb.collection('sellerSubscriptions').doc(paymentId), { sellerId: user.uid, ownerUid: user.uid, planCode, planAmount: plan.amount, badgeAmount: SELLER_BADGE_MONTHLY_FEE, amount, currency: 'KES', status: 'ACTIVE', productLimit: plan.productLimit, periodStart: now, periodEnd, paymentId, paymentMethod: 'REWARDS', createdAt: timestamp, updatedAt: timestamp });
        tx.update(sellerRef, { planCode, productLimit: plan.productLimit, planAmount: plan.amount, subscriptionStartedAt: now, subscriptionPurchasedAt: now, billingStatus: 'ACTIVE', subscriptionId: paymentId, subscriptionExpiresAt: periodEnd, badgeSubscriptionStatus: 'ACTIVE', badgeSubscriptionExpiresAt: periodEnd, verificationBadge: true, verificationBadgeGrantedBy: 'SUBSCRIPTION_PAYMENT', updatedAt: timestamp });
        const entries = allLedger.docs.map(doc => doc.data() || {}); entries.push({ status: 'POSTED', points: -points });
        const liability = entries.reduce((sum, e) => {
          const p = Number(e.points) || 0; const expires = e.expiresAt?.toMillis?.() ?? e.expiresAt?.toDate?.()?.getTime?.() ?? (e.expiresAt instanceof Date ? e.expiresAt.getTime() : null);
          if (p > 0 && expires != null && expires <= nowMs) return sum; return sum + p;
        }, 0) * pointValue;
        tx.set(configRef, { outstandingLiabilityKes: Math.max(0, Math.round(liability * 100) / 100), liabilityUpdatedAt: timestamp }, { merge: true });
        tx.set(adminDb.collection('sellerMarketplaceAudit').doc(), { action: 'SELLER_SUBSCRIPTION_REDEEMED_WITH_REWARDS', sellerId: user.uid, actorUid: user.uid, paymentId, planCode, amount, rewardPointsRedeemed: points, createdAt: timestamp });
        return { duplicate: false, paymentId, status: 'PAID', amount, currency: 'KES', planCode, rewardPointsRedeemed: points };
      });
      return res.status(200).json({ payment: result, message: result.duplicate ? 'This reward redemption was already processed.' : 'Seller plan activated using reward points.' });
    }
    const planCode = String(req.body?.planCode || '').trim().toUpperCase();
    const plan = SELLER_PLANS[planCode];
    if (!plan) throw clientError('Choose a valid seller subscription plan.');
    const durationMonths = Number(req.body?.durationMonths || 1);
    const pricingSnap = await adminDb.collection('sellerSubscriptionPricing').doc('current').get();
    const pricingConfig = pricingSnap.exists ? (pricingSnap.data()?.termDiscounts || DEFAULT_SELLER_TERM_DISCOUNTS) : DEFAULT_SELLER_TERM_DISCOUNTS;
    const pricing = calculateSellerSubscriptionPrice(planCode, durationMonths, pricingConfig);
    const phone = normalizeSellerPhone(req.body?.phone);
    const idempotencyKey = String(req.body?.idempotencyKey || '').trim();
    if (!/^[A-Za-z0-9_-]{12,100}$/.test(idempotencyKey)) throw clientError('A valid idempotency key is required.');
    const sellerRef = adminDb.collection('sellers').doc(user.uid);
    const sellerSnap = await sellerRef.get();
    if (!sellerSnap.exists || sellerSnap.data()?.ownerUid !== user.uid) throw clientError('An approved seller account is required.', 403);
    const seller = sellerSnap.data();
    if (seller.status !== 'ACTIVE') throw clientError('Your seller account is not active.', 403);
    const paymentId = sellerSubscriptionPaymentId(user.uid, idempotencyKey);
    const paymentRef = adminDb.collection('sellerSubscriptionPayments').doc(paymentId);
    const created = await adminDb.runTransaction(async tx => {
      const existing = await tx.get(paymentRef);
      if (existing.exists) {
        const data = existing.data();
        if (data.planCode !== planCode || data.phone !== phone || Number(data.durationMonths || 1) !== durationMonths) throw clientError('This idempotency key was already used for a different request.', 409);
        return { existing: true, data };
      }
      const now = FieldValue.serverTimestamp();
      const data = {
        paymentId, sellerId: user.uid, ownerUid: user.uid, planCode,
        planAmount: plan.amount, durationMonths: pricing.durationMonths, planSubtotal: pricing.planSubtotal,
        discountPercent: pricing.discountPercent, discountAmount: pricing.discountAmount,
        discountedPlanAmount: pricing.discountedPlanAmount, badgeAmount: pricing.badgeAmount,
        amount: pricing.amount, currency: 'KES',
        phone, method: 'MPESA', status: 'PENDING', providerReference: null,
        transactionReference: null, failureReason: null, idempotencyKey,
        createdAt: now, updatedAt: now, initiatedAt: now, completedAt: null,
      };
      tx.create(paymentRef, data);
      tx.set(adminDb.collection('sellerMarketplaceAudit').doc(), {
        action: 'SELLER_SUBSCRIPTION_PAYMENT_INITIATED', sellerUid: user.uid, actorUid: user.uid,
        paymentId, planCode, amount: data.amount, createdAt: FieldValue.serverTimestamp(),
      });
      return { existing: false, data };
    });
    if (created.existing) {
      if (created.data.providerReference) return res.status(202).json({ payment: { paymentId, status: created.data.status, amount: created.data.amount, currency: 'KES', providerReference: created.data.providerReference }, reused: true });
      // Do not retry an STK push when the first provider call's outcome is
      // unknown. This avoids accidentally charging a seller twice.
      throw clientError('This payment request is already being prepared. Check its status or contact support before retrying.', 409);
    }
    try {
      const stk = await getMpesaProvider().initiateStk({ phone, amount: created.data.amount });
      await paymentRef.update({ providerReference: stk.providerReference, updatedAt: FieldValue.serverTimestamp() });
      return res.status(202).json({ payment: { paymentId, status: 'PENDING', amount: created.data.amount, currency: 'KES', planCode, durationMonths: pricing.durationMonths, discountPercent: pricing.discountPercent, providerReference: stk.providerReference } });
    } catch (error) {
      await paymentRef.update({ initiationError: true, updatedAt: FieldValue.serverTimestamp() }).catch(() => {});
      throw error;
    }
  }

  if (req.method === 'GET') {
    const paymentId = Array.isArray(req.query.paymentId) ? req.query.paymentId[0] : req.query.paymentId;
    if (paymentId == null || paymentId === '') {
      const pricingSnap = await adminDb.collection('sellerSubscriptionPricing').doc('current').get();
      const termDiscounts = pricingSnap.exists ? (pricingSnap.data()?.termDiscounts || DEFAULT_SELLER_TERM_DISCOUNTS) : DEFAULT_SELLER_TERM_DISCOUNTS;
      return res.status(200).json({ termDiscounts, plans: Object.entries(SELLER_PLANS).map(([code, plan]) => ({ code, amount: plan.amount, productLimit: plan.productLimit })), badgeMonthlyFee: SELLER_BADGE_MONTHLY_FEE });
    }
    if (typeof paymentId !== 'string' || !/^[a-f0-9]{64}$/.test(paymentId)) throw clientError('Subscription payment id is invalid.');
    const paymentRef = adminDb.collection('sellerSubscriptionPayments').doc(paymentId);
    const snap = await paymentRef.get();
    if (!snap.exists) throw clientError('Subscription payment not found.', 404);
    const data = snap.data();
    if (data.ownerUid !== user.uid) throw clientError('Forbidden.', 403);
    if (data.status === 'PENDING' && data.providerReference) {
      try {
        const provider = getMpesaProvider();
        const result = await provider.checkStatus(data.providerReference);
        if (result.status !== 'PENDING') {
          await applySellerSubscriptionPayment(adminDb, { serverTimestamp: () => FieldValue.serverTimestamp() }, {
            providerReference: data.providerReference, status: result.status,
            amount: result.amount ?? data.amount,
            transactionReference: result.transactionReference,
            eventId: result.eventId || 'seller-status:' + paymentId + ':' + result.status,
            source: 'PRINTPAY', reason: result.reason || null,
          });
        } else {
          const initiatedMs = data.initiatedAt?.toMillis?.() || data.createdAt?.toMillis?.() || 0;
          if (initiatedMs && Date.now() - initiatedMs > RECONCILE_TIMEOUT_MS) {
            await applySellerSubscriptionPayment(adminDb, { serverTimestamp: () => FieldValue.serverTimestamp() }, {
              providerReference: data.providerReference, status: 'TIMEOUT', amount: Number(data.amount),
              transactionReference: null, eventId: 'seller-timeout:' + paymentId, source: 'SYSTEM',
              reason: 'The M-Pesa request timed out or was cancelled.',
            });
          }
        }
      } catch (error) {
        console.error('seller-subscription status reconciliation failed:', error?.message || error);
      }
    }
    const refreshed = await paymentRef.get();
    const current = refreshed.data() || data;
    return res.json({ payment: { paymentId, status: current.status, planCode: current.planCode, amount: current.amount, currency: current.currency, failureReason: current.failureReason || null, transactionReference: current.transactionReference || null } });
  }
  return methodNotAllowed(res, 'GET, POST');
}
