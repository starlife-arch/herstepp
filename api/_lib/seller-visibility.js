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
 * Existing HerStep-owned products have no sellerUid and remain unaffected.
 * Marketplace products are public only while their seller and subscription
 * are active. Fail closed when seller records or expiry data are missing.
 */
export async function isPublicSellerListing(db, product, now = new Date()) {
  const sellerUid = String(product?.sellerUid || '');
  if (!sellerUid) return true;

  const snapshot = await db.collection('sellers').doc(sellerUid).get();
  if (!snapshot.exists) return false;
  const seller = snapshot.data() || {};
  const expiry = toDate(seller.subscriptionExpiresAt);
  return seller.status === 'ACTIVE'
    && seller.billingStatus === 'ACTIVE'
    && Boolean(expiry && expiry.getTime() > now.getTime());
}

export async function filterPublicSellerListings(db, products, now = new Date()) {
  const sellerUids = [...new Set(products.map(product => String(product?.sellerUid || '')).filter(Boolean))];
  const sellerEntries = await Promise.all(sellerUids.map(async uid => {
    const [snapshot, applicationSnapshot] = await Promise.all([
      db.collection('sellers').doc(uid).get(),
      db.collection('sellerApplications').doc(uid).get(),
    ]);
    if (!snapshot.exists) return [uid, null];
    const seller = snapshot.data() || {};
    const application = applicationSnapshot.exists ? applicationSnapshot.data() || {} : {};
    const expiry = toDate(seller.subscriptionExpiresAt);
    const active = seller.status === 'ACTIVE' && seller.billingStatus === 'ACTIVE'
      && Boolean(expiry && expiry.getTime() > now.getTime());
    // The blue check marks a verified business. Paying for any plan (whose
    // total always includes the mandatory badge fee) grants it automatically;
    // an explicit admin revocation hides it again until the next payment.
    const badgePaid = seller.badgeSubscriptionStatus === 'ACTIVE';
    const verifiedBadgeActive = active && (seller.verificationBadge === true || badgePaid);
    return [uid, {
      active,
      displayName: String(seller.displayName || application.displayName || '').slice(0, 60),
      businessName: String(seller.businessName || application.businessName || '').slice(0, 100),
      verifiedBadgeActive,
    }];
  }));
  const sellers = new Map(sellerEntries);
  return products.filter(product => {
    const uid = String(product?.sellerUid || '');
    return !uid || sellers.get(uid)?.active === true;
  }).map(product => {
    const uid = String(product?.sellerUid || '');
    const seller = uid ? sellers.get(uid) : null;
    if (!seller) return product;
    // Live seller/application names ALWAYS win over the denormalized copy on
    // the product doc — a paid name change must never leave an old name on the
    // live shop because a background batch sync failed or was skipped.
    return {
      ...product,
      sellerDisplayName: seller.displayName || product.sellerDisplayName || '',
      sellerBusinessName: seller.businessName || product.sellerBusinessName || '',
      sellerVerificationBadgeActive: seller.verifiedBadgeActive === true,
    };
  });
}
