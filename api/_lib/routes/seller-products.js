import { FieldValue } from 'firebase-admin/firestore';
import { adminDb, requireUser } from '../firebase-admin.js';
import { clientError, methodNotAllowed } from '../http.js';
import { SELLER_PLANS } from '../seller-subscription-core.js';

const clean = value => String(value ?? '').trim();
const toDate = value => value?.toDate?.() || (value instanceof Date ? value : (typeof value === 'string' || typeof value === 'number') ? new Date(value) : null);
const sizes = new Set([...Array.from({ length: 16 }, (_, i) => String(i + 30)), 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'One Size', 'Free Size']);

function validateDraft(input) {
  const p = input && typeof input === 'object' ? input : {};
  const name = clean(p.name);
  const description = String(p.description ?? '').trim();
  const categoryId = clean(p.categoryId);
  const sku = clean(p.sku).toUpperCase();
  if (name.length < 2 || name.length > 160) throw clientError('Product name must be between 2 and 160 characters.');
  if (description.length > 4000) throw clientError('Description must be 4,000 characters or fewer.');
  if (!categoryId || categoryId.length > 100) throw clientError('Select a valid product category.');
  if (!/^[A-Z0-9_-]{1,80}$/.test(sku)) throw clientError('SKU must use uppercase letters, numbers, - or _ (max 80).');
  if (!Number.isInteger(p.price) || p.price < 0) throw clientError('Price must be a non-negative whole KSh amount.');
  if (p.salePrice !== null && p.salePrice !== undefined && (!Number.isInteger(p.salePrice) || p.salePrice < 0 || p.salePrice >= p.price)) {
    throw clientError('Sale price must be a whole number lower than the regular price.');
  }
  if (!Array.isArray(p.inventory) || p.inventory.length < 1 || p.inventory.length > 40) throw clientError('Add stock for at least one size or variant.');
  const seen = new Set();
  const inventory = p.inventory.map(item => {
    if (!item || typeof item.size !== 'string' || !sizes.has(item.size) || seen.has(item.size) ||
      !Number.isInteger(item.quantity) || item.quantity < 0 ||
      (item.costPrice !== undefined && item.costPrice !== null && item.costPrice !== '' && (!Number.isInteger(item.costPrice) || item.costPrice < 0))) {
      throw clientError('Inventory must use unique supported sizes and non-negative whole-number quantities/costs.');
    }
    seen.add(item.size);
    return { size: item.size, quantity: item.quantity, costPrice: item.costPrice === undefined || item.costPrice === '' ? null : item.costPrice };
  });
  if (!Array.isArray(p.images) || p.images.length < 1 || p.images.length > 8 ||
    p.images.some(i => !i || typeof i.url !== 'string' || !/^https:\/\//i.test(i.url) ||
      typeof i.publicId !== 'string' || i.resourceType !== 'image')) {
    throw clientError('Provide 1–8 valid uploaded product images.');
  }
  return {
    name, description, categoryId, sku, price: p.price,
    salePrice: p.salePrice ?? null, inventory, images: p.images,
    video: null, status: 'DRAFT', featured: false, bestseller: false, newArrival: false,
    stockQuantity: inventory.reduce((n, i) => n + i.quantity, 0),
    availableSizes: inventory.filter(i => i.quantity > 0).map(i => i.size),
  };
}

function serialize(value) {
  if (value?.toDate) return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(serialize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, serialize(v)]));
  return value;
}

export default async function sellerProducts(req, res) {
  const user = await requireUser(req);
  const sellerRef = adminDb.collection('sellers').doc(user.uid);
  const sellerSnap = await sellerRef.get();
  if (!sellerSnap.exists || sellerSnap.data()?.status !== 'ACTIVE') {
    throw clientError('Only approved, active sellers can manage product drafts.', 403);
  }
  if (req.method === 'GET') {
    const snapshot = await adminDb.collection('sellerProducts').where('sellerUid', '==', user.uid).get();
    const products = snapshot.docs.map(doc => serialize({ id: doc.id, ...doc.data() }))
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    const seller = sellerSnap.data() || {};
    const expiry = toDate(seller.subscriptionExpiresAt);
    const planCode = String(seller.planCode || 'STARTER').toUpperCase();
    const plan = SELLER_PLANS[planCode];
    const publishingEnabled = seller.status === 'ACTIVE' && seller.billingStatus === 'ACTIVE'
      && Boolean(expiry && Number.isFinite(expiry.getTime()) && expiry.getTime() > Date.now()) && Boolean(plan || planCode === 'UNLIMITED');
    return res.status(200).json({ products, publishingEnabled, planCode, subscriptionExpiresAt: expiry?.toISOString?.() || null });
  }
  if (!['POST', 'PATCH'].includes(req.method)) return methodNotAllowed(res, 'GET, POST, PATCH');

  if (req.method === 'PATCH' && String(req.body?.action || '').toUpperCase() === 'SUBMIT_FOR_REVIEW') {
    const id = clean(req.body?.id);
    if (!id || id.length > 150) throw clientError('A valid product draft ID is required.');
    const ref = adminDb.collection('sellerProducts').doc(id);
    const [draftSnap, sellerFresh] = await Promise.all([ref.get(), sellerRef.get()]);
    if (!draftSnap.exists || draftSnap.data()?.sellerUid !== user.uid) throw clientError('Product draft not found.', 404);
    const draft = draftSnap.data() || {};
    if (!['DRAFT', 'REJECTED'].includes(String(draft.status || '').toUpperCase())) {
      throw clientError('Only a private or rejected draft can be submitted for review.', 409);
    }
    const seller = sellerFresh.data() || {};
    const expiry = toDate(seller.subscriptionExpiresAt);
    if (seller.status !== 'ACTIVE' || seller.billingStatus !== 'ACTIVE' || !expiry || !Number.isFinite(expiry.getTime()) || expiry.getTime() <= Date.now()) {
      throw clientError('An active paid seller plan is required before submitting products for review.', 403);
    }
    const planCode = String(seller.planCode || '').toUpperCase();
    if (!SELLER_PLANS[planCode] && planCode !== 'UNLIMITED') throw clientError('Your seller plan is invalid. Please contact support.', 409);
    const now = FieldValue.serverTimestamp();
    await ref.update({
      status: 'PENDING_REVIEW', submittedAt: now, moderationReason: null,
      reviewedBy: null, reviewedAt: null, updatedAt: now,
    });
    await adminDb.collection('sellerMarketplaceAudit').add({
      action: 'SELLER_PRODUCT_SUBMITTED_FOR_REVIEW', sellerUid: user.uid,
      productDraftId: id, actorUid: user.uid, createdAt: now,
    });
    return res.status(200).json({ success: true, product: { id, ...draft, status: 'PENDING_REVIEW' }, message: 'Product submitted for admin review. It will remain private until approved and published.' });
  }

  const product = validateDraft(req.body);
  const category = await adminDb.collection('categories').doc(product.categoryId).get();
  if (!category.exists) throw clientError('The selected category does not exist.');
  const duplicate = await adminDb.collection('sellerProducts')
    .where('sellerUid', '==', user.uid).where('sku', '==', product.sku).get();
  const existingDuplicate = duplicate.docs.find(doc => doc.id !== String(req.body?.id || ''));
  if (existingDuplicate) throw clientError('You already have a product draft with this SKU.');

  const now = FieldValue.serverTimestamp();
  if (req.method === 'PATCH') {
    const id = clean(req.body?.id);
    if (!id || id.length > 150) throw clientError('A valid draft ID is required.');
    const ref = adminDb.collection('sellerProducts').doc(id);
    const snap = await ref.get();
    if (!snap.exists || snap.data()?.sellerUid !== user.uid) throw clientError('Product draft not found.', 404);
    const current = snap.data() || {};
    const currentStatus = String(current.status || '').toUpperCase();
    if (currentStatus === 'PUBLISHED') {
      const publicRef = adminDb.collection('products').doc(String(current.publishedProductId || id));
      const publicSnap = await publicRef.get();
      if (!publicSnap.exists || publicSnap.data()?.sellerUid !== user.uid) {
        throw clientError('The published marketplace listing could not be verified. Contact support before editing it.', 409);
      }
      const revision = { ...product, status: 'ACTIVE' };
      await ref.update({
        status: 'PENDING_REVIEW',
        pendingRevision: revision,
        pendingRevisionSubmittedAt: now,
        moderationReason: null,
        updatedAt: now,
      });
      await adminDb.collection('sellerMarketplaceAudit').add({
        action: 'SELLER_PRODUCT_UPDATE_SUBMITTED_FOR_REVIEW', sellerUid: user.uid,
        productDraftId: id, publicProductId: publicRef.id, actorUid: user.uid, createdAt: now,
      });
      return res.status(200).json({
        product: { id, ...current, status: 'PENDING_REVIEW', pendingRevision: revision, updatedAt: new Date().toISOString() },
        message: 'Product changes submitted for review. Your current published listing stays live until an admin approves the update.',
      });
    }
    if (!['DRAFT', 'REJECTED'].includes(currentStatus)) throw clientError('This listing cannot be edited while it is awaiting review.');
    await ref.update({ ...product, status: 'DRAFT', moderationReason: null, reviewedBy: null, reviewedAt: null, updatedAt: now });
    return res.status(200).json({
      product: { id, ...product, updatedAt: new Date().toISOString() },
      message: 'Private draft updated. It is not visible in the public shop until approved and published.',
    });
  }

  const ref = await adminDb.collection('sellerProducts').add({
    ...product,
    sellerUid: user.uid,
    sellerDisplayName: clean(sellerSnap.data()?.displayName || sellerSnap.data()?.businessName).slice(0, 60),
    createdAt: now,
    updatedAt: now,
  });
  return res.status(201).json({
    product: { id: ref.id, ...product, status: 'DRAFT' },
    message: 'Product saved as a private draft. It is not visible in the public shop.',
  });
}
