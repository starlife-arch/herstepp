import { FieldValue } from 'firebase-admin/firestore';
import { adminDb, requireAdmin } from '../firebase-admin.js';
import { clientError, methodNotAllowed } from '../http.js';
import { SELLER_PLANS } from '../seller-subscription-core.js';
import { DEFAULT_SELLER_TERM_DISCOUNTS } from '../seller-subscription-pricing.js';

const clean = value => String(value ?? '').trim();
const asIso = value => value?.toDate?.()?.toISOString?.() || (value instanceof Date ? value.toISOString() : (typeof value === 'string' ? value : null));
const serialize = value => {
  if (value?.toDate) return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(serialize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, serialize(v)]));
  return value;
};

export default async function adminMarketplaceControls(req, res) {
  const admin = await requireAdmin(req);
  if (req.method === 'GET') {
    const [sellerSnap, productSnap, pricingSnap] = await Promise.all([
      adminDb.collection('sellers').limit(300).get(),
      adminDb.collection('products').limit(300).get(),
      adminDb.collection('sellerSubscriptionPricing').doc('current').get(),
    ]);
    const sellers = sellerSnap.docs.map(doc => {
      const s = doc.data() || {};
      return { uid: doc.id, displayName: s.displayName || '', businessName: s.businessName || '',
        email: s.email || '', status: s.status || 'UNKNOWN', planCode: s.planCode || 'STARTER',
        billingStatus: s.billingStatus || 'NOT_CONFIGURED', productLimit: s.productLimit ?? 20,
        subscriptionExpiresAt: asIso(s.subscriptionExpiresAt), adminPlanOverride: s.adminPlanOverride === true };
    }).sort((a,b) => String(a.businessName || a.displayName).localeCompare(String(b.businessName || b.displayName)));
    const products = productSnap.docs.map(doc => {
      const p = doc.data() || {};
      return { id: doc.id, name: p.name || 'Untitled product', sellerUid: p.sellerUid || p.sellerId || '',
        sellerBusinessName: p.sellerBusinessName || p.sellerDisplayName || '', status: p.status || 'UNKNOWN',
        price: Number(p.salePrice ?? p.price) || 0, promotedUntil: asIso(p.promotedUntil),
        adminHidden: p.adminHidden === true || p.status === 'ADMIN_HIDDEN' };
    }).filter(p => p.sellerUid).sort((a,b) => a.name.localeCompare(b.name));
    return res.status(200).json({ sellers, products, plans: Object.entries(SELLER_PLANS).map(([code,p]) => ({code, productLimit:p.productLimit, amount:p.amount})), subscriptionTermDiscounts: pricingSnap.exists ? (pricingSnap.data()?.termDiscounts || DEFAULT_SELLER_TERM_DISCOUNTS) : DEFAULT_SELLER_TERM_DISCOUNTS });
  }
  if (req.method !== 'PATCH') return methodNotAllowed(res, 'GET, PATCH');

  const action = clean(req.body?.action).toUpperCase();
  const reason = clean(req.body?.reason).slice(0, 500);
  const now = FieldValue.serverTimestamp();
  if (action === 'SET_SUBSCRIPTION_DISCOUNTS') {
    const incoming = req.body?.termDiscounts || {};
    const termDiscounts = { 1: 0, 3: Number(incoming[3]), 6: Number(incoming[6]), 12: Number(incoming[12]) };
    if ([3, 6, 12].some(months => !Number.isFinite(termDiscounts[months]) || termDiscounts[months] < 0 || termDiscounts[months] > 50)) throw clientError('Discounts for 3, 6 and 12 months must each be between 0 and 50 percent.');
    await adminDb.collection('sellerSubscriptionPricing').doc('current').set({ termDiscounts, updatedAt: now, updatedBy: admin.uid }, { merge: true });
    await adminDb.collection('sellerMarketplaceAudit').add({ action, actorUid: admin.uid, termDiscounts, createdAt: now });
    return res.status(200).json({ success: true, termDiscounts, message: 'Seller subscription discounts updated.' });
  }
  if (['SET_PLAN', 'REVOKE_PLAN'].includes(action)) {
    const uid = clean(req.body?.sellerUid);
    if (!uid || uid.length > 128) throw clientError('Choose a valid seller.');
    const sellerRef = adminDb.collection('sellers').doc(uid);
    const snap = await sellerRef.get();
    if (!snap.exists) throw clientError('Seller account not found.', 404);
    const seller = snap.data() || {};
    if (action === 'REVOKE_PLAN') {
      await adminDb.runTransaction(async tx => {
        const fresh = await tx.get(sellerRef);
        if (!fresh.exists) throw clientError('Seller account not found.', 404);
        const data = fresh.data() || {};
        tx.update(sellerRef, { billingStatus: 'ADMIN_REVOKED', subscriptionExpiresAt: new Date(), productLimit: 0,
          adminPlanOverride: false, adminPlanRevokedAt: now, adminPlanRevokedBy: admin.uid,
          adminPlanReason: reason || 'Plan revoked by marketplace administrator', updatedAt: now });
        if (data.subscriptionId) tx.set(adminDb.collection('sellerSubscriptions').doc(String(data.subscriptionId)), {
          status: 'REVOKED_BY_ADMIN', adminActionBy: admin.uid, adminReason: reason, updatedAt: now,
        }, { merge: true });
        tx.set(adminDb.collection('sellerMarketplaceAudit').doc(), { action: 'SELLER_PLAN_REVOKED',
          sellerUid: uid, actorUid: admin.uid, reason, createdAt: now });
      });
      return res.status(200).json({ success: true, message: 'Seller plan revoked. Publishing is now disabled.' });
    }
    const planCode = clean(req.body?.planCode).toUpperCase();
    const plan = SELLER_PLANS[planCode];
    if (!plan) throw clientError('Choose a valid seller plan.');
    const days = Math.max(1, Math.min(365, Number(req.body?.days) || 30));
    const expiry = new Date(Date.now() + days * 86400000);
    const subscriptionId = 'admin_override_' + uid;
    await adminDb.runTransaction(async tx => {
      const fresh = await tx.get(sellerRef);
      if (!fresh.exists || fresh.data()?.status !== 'ACTIVE') throw clientError('Only an active seller can be assigned a plan.', 409);
      tx.set(adminDb.collection('sellerSubscriptions').doc(subscriptionId), {
        sellerId: uid, ownerUid: uid, planCode, planAmount: plan.amount, badgeAmount: 0,
        amount: 0, currency: 'KES', status: 'ACTIVE', productLimit: plan.productLimit,
        periodStart: new Date(), periodEnd: expiry, adminOverride: true, adminActionBy: admin.uid,
        adminReason: reason, updatedAt: now, createdAt: now,
      }, { merge: true });
      tx.update(sellerRef, { planCode, productLimit: plan.productLimit, planAmount: plan.amount,
        billingStatus: 'ACTIVE', subscriptionId, subscriptionExpiresAt: expiry,
        adminPlanOverride: true, adminPlanOverrideBy: admin.uid, adminPlanReason: reason,
        adminPlanAssignedAt: now, updatedAt: now });
      tx.set(adminDb.collection('sellerMarketplaceAudit').doc(), { action: 'SELLER_PLAN_OVERRIDDEN',
        sellerUid: uid, actorUid: admin.uid, planCode, days, reason, createdAt: now });
    });
    return res.status(200).json({ success: true, message: `Assigned ${planCode} for ${days} days.` });
  }

  const productId = clean(req.body?.productId);
  if (!productId || productId.length > 150) throw clientError('Choose a valid product.');
  const productRef = adminDb.collection('products').doc(productId);
  const productSnap = await productRef.get();
  if (!productSnap.exists) throw clientError('Published product not found.', 404);
  const product = productSnap.data() || {};
  if (!product.sellerUid && !product.sellerId) throw clientError('This control is only for marketplace seller products.', 409);

  if (action === 'PROMOTE' || action === 'UNPROMOTE') {
    const patch = action === 'PROMOTE'
      ? { promotedAt: now, promotedUntil: new Date(Date.now() + 7 * 86400000), adminPromoted: true, adminPromotionBy: admin.uid, adminPromotionReason: reason, updatedAt: now }
      : { promotedAt: FieldValue.delete(), promotedUntil: FieldValue.delete(), adminPromoted: false, adminPromotionBy: admin.uid, adminPromotionReason: reason, updatedAt: now };
    await productRef.update(patch);
    await adminDb.collection('sellerMarketplaceAudit').add({ action: action === 'PROMOTE' ? 'PRODUCT_PROMOTED_BY_ADMIN' : 'PRODUCT_PROMOTION_REMOVED',
      sellerUid: product.sellerUid || product.sellerId, publicProductId: productId, actorUid: admin.uid, reason, createdAt: now });
    return res.status(200).json({ success: true, message: action === 'PROMOTE' ? 'Product promoted for 7 days.' : 'Product promotion removed.' });
  }

  if (action === 'HIDE' || action === 'RESTORE') {
    if (action === 'HIDE' && product.status !== 'ACTIVE' && product.status !== 'ADMIN_HIDDEN') {
      throw clientError('Only a currently active published product can be hidden.', 409);
    }
    if (action === 'RESTORE' && product.status !== 'ADMIN_HIDDEN') throw clientError('This product is not hidden by an administrator.', 409);
    const previousStatus = product.statusBeforeAdminHide || 'ACTIVE';
    const nextStatus = action === 'HIDE' ? 'ADMIN_HIDDEN' : previousStatus;
    await productRef.update({ status: nextStatus, adminHidden: action === 'HIDE',
      ...(action === 'HIDE' ? { statusBeforeAdminHide: product.status } : { statusBeforeAdminHide: FieldValue.delete() }),
      adminModerationReason: reason, adminModerationBy: admin.uid, adminModeratedAt: now, updatedAt: now });
    const draftId = clean(product.sellerProductId || productId);
    const draftRef = adminDb.collection('sellerProducts').doc(draftId);
    const draftSnap = await draftRef.get();
    if (draftSnap.exists && draftSnap.data()?.sellerUid === (product.sellerUid || product.sellerId)) {
      await draftRef.update({ status: action === 'HIDE' ? 'ADMIN_HIDDEN' : 'PUBLISHED',
        adminHidden: action === 'HIDE', adminModerationReason: reason, updatedAt: now });
    }
    await adminDb.collection('sellerMarketplaceAudit').add({ action: action === 'HIDE' ? 'PRODUCT_HIDDEN_BY_ADMIN' : 'PRODUCT_RESTORED_BY_ADMIN',
      sellerUid: product.sellerUid || product.sellerId, publicProductId: productId, actorUid: admin.uid, reason, createdAt: now });
    return res.status(200).json({ success: true, message: action === 'HIDE' ? 'Product removed from the live shop.' : 'Product restored to the live shop.' });
  }
  throw clientError('Choose SET_PLAN, REVOKE_PLAN, PROMOTE, UNPROMOTE, HIDE, or RESTORE.');
}
