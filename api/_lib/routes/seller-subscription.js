import { FieldValue } from 'firebase-admin/firestore';
import { adminDb, requireUser } from '../firebase-admin.js';
import { getMpesaProvider } from '../mpesa-provider.js';
import { clientError, methodNotAllowed } from '../http.js';
import { SELLER_PLANS, SELLER_BADGE_MONTHLY_FEE, normalizeSellerPhone, sellerSubscriptionPaymentId, applySellerSubscriptionPayment } from '../seller-subscription-core.js';
import { RECONCILE_TIMEOUT_MS } from '../order-core.js';

export default async function sellerSubscription(req, res) {
  const user = await requireUser(req);
  if (req.method === 'POST') {
    const planCode = String(req.body?.planCode || '').trim().toUpperCase();
    const plan = SELLER_PLANS[planCode];
    if (!plan) throw clientError('Choose a valid seller subscription plan.');
    const phone = normalizeSellerPhone(req.body?.phone);
    const idempotencyKey = String(req.body?.idempotencyKey || '').trim();
    if (!/^[A-Za-z0-9_-]{12,100}$/.test(idempotencyKey)) throw clientError('A valid idempotency key is required.');
    const sellerRef = adminDb.collection('sellers').doc(user.uid);
    const sellerSnap = await sellerRef.get();
    if (!sellerSnap.exists || sellerSnap.data()?.ownerUid !== user.uid) throw clientError('An approved seller account is required.', 403);
    const seller = sellerSnap.data();
    if (seller.status !== 'ACTIVE') throw clientError('Your seller account is not active.', 403);
    const expiry = seller.subscriptionExpiresAt?.toDate?.() || (seller.subscriptionExpiresAt instanceof Date ? seller.subscriptionExpiresAt : null);
    if (seller.billingStatus === 'ACTIVE' && expiry && expiry.getTime() > Date.now()) {
      throw clientError('Your current subscription is still active. You can purchase the next plan after it expires.', 409);
    }
    const paymentId = sellerSubscriptionPaymentId(user.uid, idempotencyKey);
    const paymentRef = adminDb.collection('sellerSubscriptionPayments').doc(paymentId);
    const created = await adminDb.runTransaction(async tx => {
      const existing = await tx.get(paymentRef);
      if (existing.exists) {
        const data = existing.data();
        if (data.planCode !== planCode || data.phone !== phone) throw clientError('This idempotency key was already used for a different request.', 409);
        return { existing: true, data };
      }
      const now = FieldValue.serverTimestamp();
      const data = {
        paymentId, sellerId: user.uid, ownerUid: user.uid, planCode,
        planAmount: plan.amount, badgeAmount: SELLER_BADGE_MONTHLY_FEE,
        amount: plan.amount + SELLER_BADGE_MONTHLY_FEE, currency: 'KES',
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
      return res.status(202).json({ payment: { paymentId, status: 'PENDING', amount: created.data.amount, currency: 'KES', providerReference: stk.providerReference } });
    } catch (error) {
      await paymentRef.update({ initiationError: true, updatedAt: FieldValue.serverTimestamp() }).catch(() => {});
      throw error;
    }
  }

  if (req.method === 'GET') {
    const paymentId = Array.isArray(req.query.paymentId) ? req.query.paymentId[0] : req.query.paymentId;
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
