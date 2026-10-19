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
    const snapshot = await db.collection('sellers').doc(uid).get();
    if (!snapshot.exists) return [uid, false];
    const seller = snapshot.data() || {};
    const expiry = toDate(seller.subscriptionExpiresAt);
    return [uid, seller.status === 'ACTIVE' && seller.billingStatus === 'ACTIVE'
      && Boolean(expiry && expiry.getTime() > now.getTime())];
  }));
  const visible = new Map(sellerEntries);
  return products.filter(product => {
    const uid = String(product?.sellerUid || '');
    return !uid || visible.get(uid) === true;
  });
}
