import { FieldValue } from 'firebase-admin/firestore';
import { adminDb, requireAdmin } from '../firebase-admin.js';
import { clientError, methodNotAllowed } from '../http.js';

const clean = value => String(value ?? '').trim();

export default async function adminSellerProfile(req, res) {
  const admin = await requireAdmin(req);
  if (req.method !== 'PATCH') return methodNotAllowed(res, 'PATCH');
  const sellerUid = clean(req.body?.sellerUid);
  const displayName = clean(req.body?.displayName).slice(0, 60);
  const businessName = clean(req.body?.businessName).slice(0, 100);
  const reason = clean(req.body?.reason).slice(0, 500);
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(sellerUid)) throw clientError('A valid seller ID is required.');
  if (typeof req.body?.verificationBadge === 'boolean') {
    if (reason.length < 3) throw clientError('Add a reason for changing the verification status.');
    const sellerRef = adminDb.collection('sellers').doc(sellerUid);
    const appRef = adminDb.collection('sellerApplications').doc(sellerUid);
    await adminDb.runTransaction(async tx => {
      const [sellerSnap, appSnap] = await Promise.all([tx.get(sellerRef), tx.get(appRef)]);
      if (!sellerSnap.exists || sellerSnap.data()?.status !== 'ACTIVE') throw clientError('Only an active seller can be verified.', 409);
      const now = FieldValue.serverTimestamp();
      tx.update(sellerRef, { verificationBadge: req.body.verificationBadge, verificationBadgeUpdatedAt: now, verificationBadgeUpdatedBy: admin.uid, updatedAt: now });
      if (appSnap.exists) tx.update(appRef, { verificationBadge: req.body.verificationBadge, updatedAt: now });
      tx.set(adminDb.collection('sellerMarketplaceAudit').doc(), {
        action: req.body.verificationBadge ? 'SELLER_BUSINESS_VERIFIED' : 'SELLER_VERIFICATION_REVOKED',
        sellerUid, actorUid: admin.uid, reason, createdAt: now,
      });
    });
    return res.json({ success: true, sellerUid, verificationBadge: req.body.verificationBadge, message: req.body.verificationBadge ? 'Business verified. The blue badge will appear on active public listings.' : 'Business verification badge removed.' });
  }
  if (displayName.length < 2) throw clientError('Display name must be at least 2 characters.');
  if (businessName.length < 2) throw clientError('Business name must be at least 2 characters.');
  if (reason.length < 3) throw clientError('Add a reason for the admin profile change.');

  const sellerRef = adminDb.collection('sellers').doc(sellerUid);
  const appRef = adminDb.collection('sellerApplications').doc(sellerUid);
  await adminDb.runTransaction(async tx => {
    const [sellerSnap, appSnap] = await Promise.all([tx.get(sellerRef), tx.get(appRef)]);
    if (!sellerSnap.exists && !appSnap.exists) throw clientError('Seller profile not found.', 404);
    const now = FieldValue.serverTimestamp();
    if (sellerSnap.exists) tx.update(sellerRef, {
      displayName, businessName, businessNameChangedAt: now, businessNameChangedBy: admin.uid,
      businessNameAdminOverride: true, updatedAt: now,
    });
    if (appSnap.exists) tx.update(appRef, { displayName, businessName, updatedAt: now, lastAdminProfileOverrideAt: now, lastAdminProfileOverrideBy: admin.uid });
    tx.set(adminDb.collection('sellerMarketplaceAudit').doc(), {
      action: 'SELLER_PROFILE_ADMIN_OVERRIDE', sellerUid, actorUid: admin.uid,
      displayName, businessName, reason, createdAt: now,
    });
  });
  try {
    const products = await adminDb.collection('products').where('sellerUid', '==', sellerUid).get();
    for (let offset = 0; offset < products.docs.length; offset += 400) {
      const batch = adminDb.batch();
      for (const product of products.docs.slice(offset, offset + 400)) {
        batch.update(product.ref, { sellerDisplayName: displayName, sellerBusinessName: businessName });
      }
      await batch.commit();
    }
  } catch (error) {
    console.error('[admin-seller-profile] Seller profile saved but product display sync failed', { sellerUid, message: error?.message || String(error) });
  }
  return res.json({ success: true, sellerUid, displayName, businessName, message: 'Seller business profile updated by admin. Public product listings have been refreshed.' });
}
