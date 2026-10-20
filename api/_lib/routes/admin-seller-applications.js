import { adminDb, requireAdmin } from '../firebase-admin.js';
import { clientError, methodNotAllowed } from '../http.js';

const clean = value => String(value ?? '').trim();
const iso = value => value?.toDate?.().toISOString?.() ?? null;

export default async function adminSellerApplications(req, res) {
  const admin = await requireAdmin(req);
  if (req.method === 'GET') {
    const rawStatus = Array.isArray(req.query.status) ? req.query.status[0] : req.query.status;
    const status = clean(rawStatus || 'PENDING').toUpperCase();
    if (!['PENDING', 'APPROVED', 'REJECTED', 'SUSPENDED', 'ALL'].includes(status)) {
      throw clientError('Invalid seller application status.');
    }
    let query = adminDb.collection('sellerApplications');
    if (status !== 'ALL') query = query.where('status', '==', status);
    const snap = await query.limit(100).get();
    const applications = await Promise.all(snap.docs.map(async doc => {
      const d = doc.data();
      const applicantUid = d.applicantUid || doc.id;
      const sellerSnap = await adminDb.collection('sellers').doc(applicantUid).get();
      const seller = sellerSnap.exists ? sellerSnap.data() || {} : {};
      return {
        id: doc.id,
        applicantUid,
        applicantEmail: d.applicantEmail || '',
        displayName: d.displayName || seller.displayName || '',
        businessName: d.businessName || seller.businessName || '',
        phone: d.phone || seller.phone || '',
        categories: Array.isArray(d.categories) ? d.categories : [],
        description: d.description || '',
        status: d.status || 'PENDING',
        verificationBadge: seller.verificationBadge === true,
        adminReason: d.adminReason || '',
        createdAt: iso(d.createdAt),
        updatedAt: iso(d.updatedAt),
      };
    })).then(rows => rows.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))));
    return res.json({ applications });
  }

  if (req.method !== 'PATCH') return methodNotAllowed(res, 'GET, PATCH');
  const applicantUid = clean(req.body?.applicantUid);
  const status = clean(req.body?.status).toUpperCase();
  const adminReason = clean(req.body?.reason).slice(0, 500);
  if (!applicantUid || applicantUid.length > 128) throw clientError('Invalid seller application.');
  if (!['APPROVED', 'REJECTED', 'SUSPENDED', 'REINSTATED'].includes(status)) {
    throw clientError('Choose APPROVED, REJECTED, SUSPENDED, or REINSTATED.');
  }
  if (status === 'REJECTED' && adminReason.length < 3) throw clientError('Provide a short reason when rejecting an application.');

  const appRef = adminDb.collection('sellerApplications').doc(applicantUid);
  const sellerRef = adminDb.collection('sellers').doc(applicantUid);
  const now = new Date();
  await adminDb.runTransaction(async tx => {
    const appSnap = await tx.get(appRef);
    const sellerSnap = await tx.get(sellerRef);
    if (!appSnap.exists) throw clientError('Seller application not found.', 404);
    const app = appSnap.data();
    if (status === 'APPROVED') {
      tx.set(sellerRef, {
        ownerUid: applicantUid,
        displayName: app.displayName,
        businessName: app.businessName || '',
        status: 'ACTIVE',
        planCode: 'STARTER',
        billingStatus: 'NOT_CONFIGURED',
        verificationBadge: false,
        createdAt: sellerSnap.exists ? sellerSnap.data()?.createdAt || now : now,
        updatedAt: now,
      }, { merge: true });
      tx.update(appRef, { status: 'APPROVED', adminReason: adminReason || '', reviewedBy: admin.uid, reviewedAt: now, updatedAt: now });
    } else if (status === 'REJECTED') {
      tx.update(appRef, { status, adminReason, reviewedBy: admin.uid, reviewedAt: now, updatedAt: now });
    } else {
      if (!sellerSnap.exists) throw clientError('An approved seller account is required for this action.');
      const nextStatus = status === 'SUSPENDED' ? 'SUSPENDED' : 'ACTIVE';
      tx.update(sellerRef, { status: nextStatus, updatedAt: now, statusChangedBy: admin.uid, statusReason: adminReason });
      if (status === 'SUSPENDED') {
        tx.update(appRef, { status: 'SUSPENDED', adminReason, reviewedBy: admin.uid, reviewedAt: now, updatedAt: now });
      } else {
        tx.update(appRef, { status: 'APPROVED', adminReason: '', reviewedBy: admin.uid, reviewedAt: now, updatedAt: now });
      }
    }
    const auditRef = adminDb.collection('sellerMarketplaceAudit').doc();
    tx.set(auditRef, {
      action: status,
      applicantUid,
      actorUid: admin.uid,
      reason: adminReason,
      createdAt: now,
    });
  });
  return res.json({ success: true, applicantUid, status, message: 'Seller application updated.' });
}
