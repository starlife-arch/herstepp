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
    const [snapshot, publicSnapshot] = await Promise.all([
      adminDb.collection('sellerProducts').where('sellerUid', '==', user.uid).get(),
      adminDb.collection('products').where('sellerUid', '==', user.uid).get(),
    ]);
    const draftProducts = snapshot.docs.map(doc => serialize({ id: doc.id, ...doc.data() }));
    const representedPublicIds = new Set(draftProducts.map(product => String(product.publishedProductId || product.id)));
    const additionalPublished = publicSnapshot.docs
      .filter(doc => String(doc.data()?.status || '').toUpperCase() === 'ACTIVE' && !representedPublicIds.has(doc.id))
      .map(doc => serialize({ id: doc.id, ...doc.data(), status: 'PUBLISHED', publishedProductId: doc.id }));
    const products = [...draftProducts, ...additionalPublished]
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

  if (req.method === 'PATCH' && String(req.body?.action || '').toUpperCase() === 'PUBLISH') {
    const id = clean(req.body?.id);
    if (!id || id.length > 150) throw clientError('A valid product draft ID is required.');
    const draftRef = adminDb.collection('sellerProducts').doc(id);
    const draftSnap = await draftRef.get();
    if (!draftSnap.exists || draftSnap.data()?.sellerUid !== user.uid) throw clientError('Product draft not found.', 404);
    const draft = draftSnap.data() || {};
    if (!['DRAFT', 'REJECTED'].includes(String(draft.status || '').toUpperCase())) {
      if (String(draft.status || '').toUpperCase() === 'PUBLISHED') throw clientError('This product is already published.', 409);
      throw clientError('Only a private or rejected draft can be published.', 409);
    }
    // Validate the saved draft, not the small action request. The request contains
    // only {id, action}, which previously caused the misleading empty-name error.
    const product = validateDraft(draft);
    if (!(await adminDb.collection('categories').doc(product.categoryId).get()).exists) throw clientError('The selected category does not exist.');
    const seller = sellerSnap.data() || {};
    const expiry = toDate(seller.subscriptionExpiresAt);
    if (seller.status !== 'ACTIVE' || seller.billingStatus !== 'ACTIVE' || !expiry || !Number.isFinite(expiry.getTime()) || expiry.getTime() <= Date.now()) {
      throw clientError('An active paid seller plan is required to publish listings.', 403);
    }
    const planCode = String(seller.planCode || '').toUpperCase();
    const plan = SELLER_PLANS[planCode];
    if (!plan && planCode !== 'UNLIMITED') throw clientError('Your seller plan is invalid. Please contact support.', 409);
    const publicRef = adminDb.collection('products').doc();
    const now = FieldValue.serverTimestamp();
    const publicProduct = {
      ...product, status: 'ACTIVE', sellerUid: user.uid, sellerId: user.uid,
      sellerDisplayName: clean(seller.displayName || seller.businessName).slice(0, 60),
      sellerBusinessName: clean(seller.businessName).slice(0, 100),
      marketplaceSeller: true, moderationStatus: 'APPROVED',
      createdAt: now, updatedAt: now, publishedAt: now,
    };
    await adminDb.runTransaction(async tx => {
      const [freshDraft, freshSeller] = await Promise.all([tx.get(draftRef), tx.get(sellerRef)]);
      if (!freshDraft.exists || freshDraft.data()?.sellerUid !== user.uid || !['DRAFT', 'REJECTED'].includes(String(freshDraft.data()?.status || '').toUpperCase())) {
        throw clientError('This draft was changed or published in another request. Refresh your products.', 409);
      }
      if (!freshSeller.exists || freshSeller.data()?.status !== 'ACTIVE' || freshSeller.data()?.billingStatus !== 'ACTIVE') {
        throw clientError('Seller account is no longer active.', 403);
      }
      const [sellerProducts, publicProducts] = await Promise.all([
        adminDb.collection('sellerProducts').where('sellerUid', '==', user.uid).get(),
        adminDb.collection('products').where('sellerUid', '==', user.uid).get(),
      ]);
      const activeCount = publicProducts.docs.filter(d => String(d.data()?.status || '').toUpperCase() === 'ACTIVE').length;
      const limit = plan?.productLimit ?? (planCode === 'UNLIMITED' ? Infinity : 0);
      if (activeCount >= limit) throw clientError('You have reached the active product limit for your seller plan.', 409);
      if (publicProducts.docs.some(d => String(d.data()?.status || '').toUpperCase() === 'ACTIVE' && String(d.data()?.sku || '').toUpperCase() === product.sku)) {
        throw clientError('Another published product already uses this SKU.', 409);
      }
      tx.create(publicRef, publicProduct);
      tx.update(draftRef, { ...product, status: 'PUBLISHED', publishedProductId: publicRef.id, moderationStatus: 'APPROVED', publishedAt: now, updatedAt: now });
      tx.create(adminDb.collection('sellerMarketplaceAudit').doc(), {
        action: 'SELLER_PRODUCT_PUBLISHED', sellerUid: user.uid, productDraftId: id,
        publicProductId: publicRef.id, actorUid: user.uid, createdAt: now,
      });
    });
    return res.status(200).json({ success: true, product: serialize({ id, ...product, status: 'PUBLISHED', publishedProductId: publicRef.id, sellerUid: user.uid, sellerBusinessName: seller.businessName || '', publishedAt: new Date().toISOString() }), message: 'Product published successfully. Admin approval is not required for routine listings; marketplace moderation still applies.' });
  }

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

  if (req.method === 'PATCH' && String(req.body?.action || '').toUpperCase() === 'UPDATE_PUBLISHED') {
    const id = clean(req.body?.id);
    if (!id || id.length > 150) throw clientError('A valid published product ID is required.');
    const product = validateDraft(req.body);
    const category = await adminDb.collection('categories').doc(product.categoryId).get();
    if (!category.exists) throw clientError('The selected category does not exist.');
    const seller = sellerSnap.data() || {};
    const expiry = toDate(seller.subscriptionExpiresAt);
    if (seller.status !== 'ACTIVE' || seller.billingStatus !== 'ACTIVE' || !expiry || !Number.isFinite(expiry.getTime()) || expiry.getTime() <= Date.now()) {
      throw clientError('An active paid seller plan is required to edit a published listing.', 403);
    }
    const publicRef = adminDb.collection('products').doc(id);
    const draftRef = adminDb.collection('sellerProducts').doc(id);
    const duplicateSnap = await adminDb.collection('products').where('sellerUid', '==', user.uid).get();
    if (duplicateSnap.docs.some(doc => doc.id !== id && String(doc.data()?.status || '').toUpperCase() === 'ACTIVE' && String(doc.data()?.sku || '').toUpperCase() === product.sku)) {
      throw clientError('Another published product already uses this SKU.');
    }
    let responseProduct = null;
    await adminDb.runTransaction(async tx => {
      const [publicSnap, draftSnap] = await Promise.all([tx.get(publicRef), tx.get(draftRef)]);
      if (!publicSnap.exists || publicSnap.data()?.sellerUid !== user.uid || String(publicSnap.data()?.status || '').toUpperCase() !== 'ACTIVE') {
        throw clientError('Published product not found or no longer editable.', 404);
      }
      const current = publicSnap.data() || {};
      // The current seller form edits one variant at a time. Merge those
      // variant changes into existing inventory so editing a published shoe
      // does not accidentally delete every other size from the public listing.
      const currentInventory = Array.isArray(current.inventory) ? current.inventory : [];
      const editedBySize = new Map(product.inventory.map(item => [item.size, item]));
      const mergedInventory = [
        ...currentInventory.filter(item => !editedBySize.has(item.size)),
        ...product.inventory,
      ];
      const updated = {
        // Keep existing public listing metadata while applying seller-editable
        // fields; otherwise an edit could silently clear merchandising flags.
        ...current,
        ...product,
        inventory: mergedInventory,
        stockQuantity: mergedInventory.reduce((sum, item) => sum + (Number(item.quantity) || 0), 0),
        availableSizes: mergedInventory.filter(item => Number(item.quantity) > 0).map(item => item.size),
        status: 'ACTIVE',
        sellerUid: user.uid,
        sellerId: user.uid,
        sellerDisplayName: clean(seller.displayName || seller.businessName).slice(0, 60),
        sellerBusinessName: clean(seller.businessName).slice(0, 100),
        marketplaceSeller: true,
        featured: current.featured === true,
        bestseller: current.bestseller === true,
        newArrival: current.newArrival === true,
        video: current.video ?? null,
        sellerVerificationBadgeActive: current.sellerVerificationBadgeActive === true,
        moderationStatus: current.moderationStatus || 'APPROVED',
        promotedUntil: current.promotedUntil || null,
        promotedPaymentId: current.promotedPaymentId || null,
        promotedAt: current.promotedAt || null,
        createdAt: current.createdAt || FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      };
      tx.update(publicRef, updated);
      // Return the complete merged inventory to the editor. Returning only the
      // one edited variant made the UI forget the other sizes until refresh.
      responseProduct = {
        id, ...product, inventory: mergedInventory,
        stockQuantity: updated.stockQuantity,
        availableSizes: updated.availableSizes,
        status: 'PUBLISHED', sellerUid: user.uid, sellerId: user.uid,
        sellerDisplayName: updated.sellerDisplayName,
        sellerBusinessName: updated.sellerBusinessName,
        marketplaceSeller: true,
        featured: updated.featured,
        bestseller: updated.bestseller,
        newArrival: updated.newArrival,
        sellerVerificationBadgeActive: updated.sellerVerificationBadgeActive,
        moderationStatus: updated.moderationStatus,
        promotedUntil: updated.promotedUntil,
        promotedPaymentId: updated.promotedPaymentId,
        promotedAt: updated.promotedAt,
        updatedAt: new Date().toISOString(),
      };
      if (draftSnap.exists && draftSnap.data()?.sellerUid === user.uid) {
        tx.update(draftRef, { ...product, status: 'PUBLISHED', publishedProductId: id, sellerUid: user.uid, updatedAt: FieldValue.serverTimestamp() });
      }
      tx.set(adminDb.collection('sellerMarketplaceAudit').doc(), {
        action: 'SELLER_PUBLISHED_PRODUCT_EDITED', sellerUid: user.uid, productId: id,
        actorUid: user.uid, updatedFields: ['name', 'description', 'categoryId', 'sku', 'price', 'salePrice', 'inventory', 'images'],
        createdAt: FieldValue.serverTimestamp(),
      });
    });
    return res.status(200).json({
      product: responseProduct || { id, ...product, status: 'PUBLISHED', sellerUid: user.uid, sellerBusinessName: seller.businessName || '' },
      message: 'Published listing updated successfully.',
    });
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
    if (!['DRAFT', 'REJECTED'].includes(String(snap.data()?.status || '').toUpperCase())) throw clientError('Only private or rejected drafts can be edited.');
    await ref.update({ ...product, status: 'DRAFT', moderationReason: null, reviewedBy: null, reviewedAt: null, updatedAt: now });
    return res.status(200).json({
      product: { id, ...product, updatedAt: new Date().toISOString() },
      message: 'Private draft updated and returned to draft status. It is not visible in the public shop.',
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
