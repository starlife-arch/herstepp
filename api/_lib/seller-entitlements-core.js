import { SELLER_PLANS } from './seller-subscription-core.js';

function toDate(value) {
  if (value?.toDate) return value.toDate();
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

/**
 * Server-side entitlement snapshot for seller publishing.
 * Drafts do not count toward plan limits; only active public catalogue records do.
 * Publishing must call this helper again immediately before writing a public product.
 */
export async function getSellerEntitlements(db, sellerUid, now = new Date()) {
  const sellerRef = db.collection('sellers').doc(sellerUid);
  const sellerSnap = await sellerRef.get();
  if (!sellerSnap.exists) {
    return { sellerActive: false, subscriptionActive: false, canPublish: false, reason: 'SELLER_NOT_FOUND', planCode: null, productLimit: 0, activeProductCount: 0, remainingProducts: 0, expiresAt: null };
  }

  const seller = sellerSnap.data() || {};
  const planCode = String(seller.planCode || 'STARTER').toUpperCase();
  const plan = SELLER_PLANS[planCode];
  const productLimit = plan?.productLimit ?? (planCode === 'UNLIMITED' ? null : 0);
  const expiry = toDate(seller.subscriptionExpiresAt);
  const sellerActive = seller.status === 'ACTIVE';
  const subscriptionActive = seller.billingStatus === 'ACTIVE' && Boolean(expiry && expiry.getTime() > now.getTime());

  const productsSnap = await db.collection('products').where('sellerUid', '==', sellerUid).get();
  const activeProductCount = productsSnap.docs.reduce((count, doc) => {
    const status = String(doc.data()?.status || '').toUpperCase();
    return count + (['ACTIVE', 'PUBLISHED'].includes(status) ? 1 : 0);
  }, 0);

  let reason = null;
  if (!sellerActive) reason = 'SELLER_NOT_ACTIVE';
  else if (!subscriptionActive) reason = 'SUBSCRIPTION_INACTIVE_OR_EXPIRED';
  else if (productLimit !== null && activeProductCount >= productLimit) reason = 'PRODUCT_LIMIT_REACHED';

  return {
    sellerActive,
    subscriptionActive,
    canPublish: reason === null,
    reason,
    planCode: plan || planCode === 'UNLIMITED' ? planCode : null,
    productLimit,
    activeProductCount,
    remainingProducts: productLimit === null ? null : Math.max(0, productLimit - activeProductCount),
    expiresAt: expiry ? expiry.toISOString() : null,
  };
}
