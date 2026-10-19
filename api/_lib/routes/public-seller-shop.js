import { adminDb } from '../firebase-admin.js';
import { methodNotAllowed } from '../http.js';

function toDate(value) {
  if (value?.toDate) return value.toDate();
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
}

function iso(value) {
  const date = toDate(value);
  return date ? date.toISOString() : null;
}

function serializeProduct(doc) {
  const product = doc.data() || {};
  return {
    id: doc.id,
    name: String(product.name || ''),
    description: String(product.description || ''),
    categoryId: String(product.categoryId || ''),
    sku: String(product.sku || ''),
    price: Number(product.price) || 0,
    salePrice: Number.isFinite(Number(product.salePrice)) && Number(product.salePrice) > 0
      ? Number(product.salePrice) : null,
    images: Array.isArray(product.images) ? product.images.map(image => ({
      url: String(image?.url || ''),
      publicId: String(image?.publicId || ''),
      resourceType: 'image',
    })).filter(image => image.url.startsWith('https://')) : [],
    inventory: Array.isArray(product.inventory) ? product.inventory.map(item => ({
      size: String(item?.size || ''),
      quantity: Math.max(0, Number(item?.quantity) || 0),
    })) : [],
    stockQuantity: Math.max(0, Number(product.stockQuantity) || 0),
    createdAt: iso(product.createdAt),
  };
}

export default async function publicSellerShop(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
  const rawId = Array.isArray(req.query.sellerId) ? req.query.sellerId[0] : req.query.sellerId;
  const sellerId = String(rawId || '').trim();
  if (!sellerId || sellerId.length > 128) {
    return res.status(404).json({ error: 'Seller shop not found.' });
  }

  const [sellerSnap, applicationSnap] = await Promise.all([
    adminDb.collection('sellers').doc(sellerId).get(),
    adminDb.collection('sellerApplications').doc(sellerId).get(),
  ]);
  if (!sellerSnap.exists) return res.status(404).json({ error: 'Seller shop not found.' });

  const seller = sellerSnap.data() || {};
  const expiresAt = toDate(seller.subscriptionExpiresAt);
  const subscriptionActive = seller.status === 'ACTIVE'
    && seller.billingStatus === 'ACTIVE'
    && Boolean(expiresAt && expiresAt.getTime() > Date.now());
  if (!subscriptionActive) return res.status(404).json({ error: 'This seller shop is not currently available.' });

  const application = applicationSnap.exists ? applicationSnap.data() || {} : {};
  const productsSnap = await adminDb.collection('products')
    .where('sellerUid', '==', sellerId)
    .limit(200)
    .get();
  const products = productsSnap.docs
    .filter(doc => String(doc.data()?.status || '').toUpperCase() === 'ACTIVE')
    .map(serializeProduct)
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

  const badgeExpiry = toDate(seller.badgeSubscriptionExpiresAt);
  const verifiedBadgeActive = seller.verificationBadge === true
    && seller.badgeSubscriptionStatus === 'ACTIVE'
    && Boolean(badgeExpiry && badgeExpiry.getTime() > Date.now());

  res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=120');
  return res.status(200).json({
    shop: {
      id: sellerId,
      displayName: String(seller.displayName || application.displayName || 'Seller shop').slice(0, 60),
      businessName: String(seller.businessName || application.businessName || '').slice(0, 100),
      description: String(application.description || '').slice(0, 500),
      categories: Array.isArray(application.categories) ? application.categories.slice(0, 8) : [],
      verifiedBadgeActive,
      planCode: String(seller.planCode || 'STARTER'),
      subscriptionExpiresAt: expiresAt.toISOString(),
    },
    products,
  });
}
