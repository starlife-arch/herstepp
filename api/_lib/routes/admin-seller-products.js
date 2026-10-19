import { FieldValue } from 'firebase-admin/firestore';
import { adminDb, requireAdmin } from '../firebase-admin.js';
import { clientError, methodNotAllowed } from '../http.js';
import { SELLER_PLANS } from '../seller-subscription-core.js';

const clean = value => String(value ?? '').trim();
const iso = value => value?.toDate?.().toISOString?.() ?? null;
const toDate = value => value?.toDate?.() || (value instanceof Date ? value : (typeof value === 'string' || typeof value === 'number') ? new Date(value) : null);

function serialize(value) {
  if (value?.toDate) return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(serialize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, serialize(v)]));
  return value;
}

export default async function adminSellerProducts(req, res) {
  const admin = await requireAdmin(req);
  if (req.method === 'GET') {
    const rawStatus = Array.isArray(req.query.status) ? req.query.status[0] : req.query.status;
    const status = clean(rawStatus || 'ALL').toUpperCase();
    if (!['ALL', 'DRAFT', 'PENDING_REVIEW', 'APPROVED', 'REJECTED', 'PUBLISHED'].includes(status)) {
      throw clientError('Invalid seller product status.');
    }
    let query = adminDb.collection('sellerProducts');
    if (status !== 'ALL') query = query.where('status', '==', status);
    const snapshot = await query.limit(200).get();
    const products = snapshot.docs.map(doc => serialize({ id: doc.id, ...doc.data() }))
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    return res.status(200).json({ products });
  }

  if (req.method !== 'PATCH') return methodNotAllowed(res, 'GET, PATCH');
  const id = clean(req.body?.id);
  const action = clean(req.body?.action).toUpperCase();
  const reason = clean(req.body?.reason).slice(0, 500);
  if (!id || id.length > 150) throw clientError('A valid seller product ID is required.');
  if (!['APPROVE', 'REJECT', 'PUBLISH'].includes(action)) throw clientError('Choose APPROVE, REJECT, or PUBLISH.');
  if (action === 'REJECT' && reason.length < 3) throw clientError('Provide a short reason when rejecting a listing.');

  const draftRef = adminDb.collection('sellerProducts').doc(id);
  const draftSnap = await draftRef.get();
  if (!draftSnap.exists) throw clientError('Seller product draft not found.', 404);
  const draft = draftSnap.data() || {};
  if (!draft.sellerUid) throw clientError('This draft has no seller owner and cannot be published.', 409);

  // Published listings stay live while edits are reviewed. Approving a revision
  // updates the public product and its seller record atomically; rejecting it
  // discards only the proposed revision and preserves the current live listing.
  if (draft.pendingRevision && draft.publishedProductId && ['APPROVE', 'REJECT'].includes(action)) {
    if (action === 'REJECT') {
      await draftRef.update({
        status: 'PUBLISHED', pendingRevision: FieldValue.delete(),
        moderationReason: reason, revisionRejectedAt: FieldValue.serverTimestamp(),
        reviewedBy: admin.uid, reviewedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
      });
      await adminDb.collection('sellerMarketplaceAudit').add({
        action: 'SELLER_PRODUCT_UPDATE_REJECTED', sellerUid: draft.sellerUid,
        productDraftId: id, publicProductId: draft.publishedProductId, actorUid: admin.uid,
        reason, createdAt: FieldValue.serverTimestamp(),
      });
      return res.status(200).json({ success: true, status: 'PUBLISHED', message: 'Update rejected. The existing published listing remains unchanged and live.' });
    }

    const revision = draft.pendingRevision;
    const categoryRef = adminDb.collection('categories').doc(clean(revision.categoryId));
    if (!(await categoryRef.get()).exists) throw clientError('The revised product category no longer exists.', 409);
    const sellerRef = adminDb.collection('sellers').doc(draft.sellerUid);
    const publicRef = adminDb.collection('products').doc(String(draft.publishedProductId));
    const now = FieldValue.serverTimestamp();
    await adminDb.runTransaction(async tx => {
      const [sellerSnap, currentDraftSnap, publicSnap] = await Promise.all([
        tx.get(sellerRef), tx.get(draftRef), tx.get(publicRef),
      ]);
      if (!sellerSnap.exists || sellerSnap.data()?.status !== 'ACTIVE') throw clientError('Seller is not active. Updating this listing is blocked.', 403);
      if (!currentDraftSnap.exists || currentDraftSnap.data()?.status !== 'PENDING_REVIEW' || !currentDraftSnap.data()?.pendingRevision) {
        throw clientError('This product update is no longer awaiting review.', 409);
      }
      if (!publicSnap.exists || publicSnap.data()?.sellerUid !== draft.sellerUid) throw clientError('The public listing no longer belongs to this seller.', 409);
      const seller = sellerSnap.data() || {};
      const expiry = toDate(seller.subscriptionExpiresAt);
      if (seller.billingStatus !== 'ACTIVE' || !expiry || !Number.isFinite(expiry.getTime()) || expiry.getTime() <= Date.now()) {
        throw clientError('The seller subscription is inactive or expired. Renew it before applying product changes.', 409);
      }
      const publicProductPatch = {
        name: clean(revision.name), description: String(revision.description || ''),
        categoryId: clean(revision.categoryId), sku: clean(revision.sku).toUpperCase(),
        price: revision.price, salePrice: revision.salePrice ?? null,
        inventory: Array.isArray(revision.inventory) ? revision.inventory : [],
        images: Array.isArray(revision.images) ? revision.images : [], video: revision.video || null,
        stockQuantity: Number.isInteger(revision.stockQuantity) ? revision.stockQuantity : 0,
        availableSizes: Array.isArray(revision.availableSizes) ? revision.availableSizes : [],
        sellerDisplayName: clean(seller.displayName || draft.sellerDisplayName).slice(0, 60),
        sellerBusinessName: clean(seller.businessName).slice(0, 100),
        status: 'ACTIVE', moderationStatus: 'APPROVED', updatedAt: now,
      };
      tx.update(publicRef, publicProductPatch);
      tx.update(draftRef, {
        ...revision, status: 'PUBLISHED', pendingRevision: FieldValue.delete(),
        moderationReason: '', reviewedBy: admin.uid, reviewedAt: now, updatedAt: now,
      });
      tx.set(adminDb.collection('sellerMarketplaceAudit').doc(), {
        action: 'SELLER_PRODUCT_UPDATE_APPROVED', sellerUid: draft.sellerUid,
        productDraftId: id, publicProductId: publicRef.id, actorUid: admin.uid, createdAt: now,
      });
    });
    return res.status(200).json({ success: true, status: 'PUBLISHED', message: 'Product update approved and applied to the live listing.' });
  }

  if (action === 'REJECT') {
    if (['PUBLISHED'].includes(String(draft.status || '').toUpperCase())) throw clientError('Unpublish this listing through the seller moderation controls before rejecting it.', 409);
    await draftRef.update({
      status: 'REJECTED', moderationReason: reason, reviewedBy: admin.uid,
      reviewedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    });
    await adminDb.collection('sellerMarketplaceAudit').add({
      action: 'SELLER_PRODUCT_REJECTED', sellerUid: draft.sellerUid, productDraftId: id,
      actorUid: admin.uid, reason, createdAt: FieldValue.serverTimestamp(),
    });
    return res.status(200).json({ success: true, status: 'REJECTED', message: 'Listing rejected. It remains private to the marketplace.' });
  }

  if (action === 'APPROVE') {
    if (!['DRAFT', 'PENDING_REVIEW', 'REJECTED', 'APPROVED'].includes(String(draft.status || '').toUpperCase())) {
      throw clientError('Only an unpublished seller draft can be approved.', 409);
    }
    await draftRef.update({
      status: 'APPROVED', moderationReason: '', reviewedBy: admin.uid,
      reviewedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    });
    await adminDb.collection('sellerMarketplaceAudit').add({
      action: 'SELLER_PRODUCT_APPROVED', sellerUid: draft.sellerUid, productDraftId: id,
      actorUid: admin.uid, createdAt: FieldValue.serverTimestamp(),
    });
    return res.status(200).json({
      success: true, status: 'APPROVED',
      message: 'Listing approved but still private. Publish it separately after the seller subscription and product limit checks pass.',
    });
  }

  if (String(draft.status || '').toUpperCase() !== 'APPROVED') {
    throw clientError('Approve this listing before publishing it.', 409);
  }
  const categoryRef = adminDb.collection('categories').doc(clean(draft.categoryId));
  if (!(await categoryRef.get()).exists) throw clientError('The product category no longer exists.', 409);

  const sellerRef = adminDb.collection('sellers').doc(draft.sellerUid);
  const publicRef = adminDb.collection('products').doc(id);
  const result = await adminDb.runTransaction(async tx => {
    const [sellerSnap, currentDraftSnap, publicSnap, sellerProductsSnap] = await Promise.all([
      tx.get(sellerRef), tx.get(draftRef), tx.get(publicRef),
      tx.get(adminDb.collection('products').where('sellerUid', '==', draft.sellerUid)),
    ]);
    if (!sellerSnap.exists || sellerSnap.data()?.status !== 'ACTIVE') throw clientError('Seller is not active. Publishing is blocked.', 403);
    if (!currentDraftSnap.exists || currentDraftSnap.data()?.status !== 'APPROVED') throw clientError('Listing is no longer approved.', 409);
    if (publicSnap.exists) throw clientError('A public product already exists for this draft.', 409);

    const seller = sellerSnap.data();
    const expiry = toDate(seller.subscriptionExpiresAt);
    if (seller.billingStatus !== 'ACTIVE' || !expiry || expiry.getTime() <= Date.now()) {
      throw clientError('The seller subscription is inactive or expired. Renew it before publishing.', 409);
    }
    const planCode = String(seller.planCode || 'STARTER').toUpperCase();
    const plan = SELLER_PLANS[planCode];
    if (!plan && planCode !== 'UNLIMITED') throw clientError('Seller plan is invalid. Publishing is blocked.', 409);
    const limit = plan?.productLimit ?? null;
    const activeCount = sellerProductsSnap.docs.reduce((count, doc) => {
      const status = String(doc.data()?.status || '').toUpperCase();
      return count + (['ACTIVE', 'PUBLISHED'].includes(status) ? 1 : 0);
    }, 0);
    if (limit !== null && activeCount >= limit) throw clientError('The seller has reached the active product limit for this plan.', 409);

    const publicProduct = {
      name: clean(draft.name),
      description: String(draft.description || ''),
      categoryId: clean(draft.categoryId),
      sku: clean(draft.sku).toUpperCase(),
      price: draft.price,
      salePrice: draft.salePrice ?? null,
      inventory: Array.isArray(draft.inventory) ? draft.inventory : [],
      images: Array.isArray(draft.images) ? draft.images : [],
      video: draft.video || null,
      status: 'ACTIVE',
      featured: false, bestseller: false, newArrival: false,
      stockQuantity: Number.isInteger(draft.stockQuantity) ? draft.stockQuantity : 0,
      availableSizes: Array.isArray(draft.availableSizes) ? draft.availableSizes : [],
      sellerUid: draft.sellerUid,
      sellerId: draft.sellerUid,
      sellerDisplayName: clean(seller.displayName || draft.sellerDisplayName).slice(0, 60),
      sellerBusinessName: clean(seller.businessName).slice(0, 100),
      marketplaceSeller: true,
      moderationStatus: 'APPROVED',
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    };
    tx.create(publicRef, publicProduct);
    tx.update(draftRef, {
      status: 'PUBLISHED', publishedProductId: id, publishedAt: FieldValue.serverTimestamp(),
      reviewedBy: admin.uid, updatedAt: FieldValue.serverTimestamp(),
    });
    tx.set(adminDb.collection('sellerMarketplaceAudit').doc(), {
      action: 'SELLER_PRODUCT_PUBLISHED', sellerUid: draft.sellerUid, productDraftId: id,
      publicProductId: id, actorUid: admin.uid, planCode, createdAt: FieldValue.serverTimestamp(),
    });
    return { id, sellerUid: draft.sellerUid, planCode, activeProductCount: activeCount + 1, limit };
  });
  return res.status(200).json({ success: true, status: 'PUBLISHED', product: result, message: 'Listing is now public.' });
}
