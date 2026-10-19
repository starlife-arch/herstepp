import { FieldValue } from 'firebase-admin/firestore';
import { adminDb, requireUser, requireAdmin } from '../firebase-admin.js';
import { clientError, methodNotAllowed } from '../http.js';

const clean = value => String(value ?? '').trim();
const allowedReasons = new Set(['COUNTERFEIT_OR_MISLEADING', 'SUSPICIOUS_SELLER', 'PROHIBITED_ITEM', 'WRONG_INFORMATION', 'OTHER']);

function serialize(value) {
  if (value?.toDate) return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(serialize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, serialize(v)]));
  return value;
}

export async function create(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
  const user = await requireUser(req);
  const productId = clean(req.body?.productId);
  const reasonCode = clean(req.body?.reasonCode).toUpperCase();
  const details = clean(req.body?.details).slice(0, 1000);
  if (!productId || productId.length > 150) throw clientError('A valid product is required.');
  if (!allowedReasons.has(reasonCode)) throw clientError('Choose a valid report reason.');
  if (reasonCode === 'OTHER' && details.length < 10) throw clientError('Please explain the issue in at least 10 characters.');
  const productRef = adminDb.collection('products').doc(productId);
  const productSnap = await productRef.get();
  if (!productSnap.exists || String(productSnap.data()?.sellerUid || '') === '') {
    throw clientError('Only marketplace seller listings can be reported.', 404);
  }
  const product = productSnap.data() || {};
  if (product.sellerUid === user.uid) throw clientError('You cannot report your own listing.');
  const priorReports = await adminDb.collection('sellerMarketplaceReports')
    .where('reporterUid', '==', user.uid).limit(200).get();
  const hasOpenDuplicate = priorReports.docs.some(doc => {
    const report = doc.data() || {};
    return report.productId === productId && report.status === 'OPEN';
  });
  if (hasOpenDuplicate) throw clientError('You already have an open report for this listing.', 409);
  const ref = await adminDb.collection('sellerMarketplaceReports').add({
    productId, productName: clean(product.name).slice(0, 160),
    sellerUid: product.sellerUid, sellerDisplayName: clean(product.sellerDisplayName || product.sellerBusinessName).slice(0, 100),
    reporterUid: user.uid, reasonCode, details, status: 'OPEN',
    createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
  });
  await adminDb.collection('sellerMarketplaceAudit').add({
    action: 'MARKETPLACE_LISTING_REPORTED', reportId: ref.id, productId, sellerUid: product.sellerUid,
    actorUid: user.uid, reasonCode, createdAt: FieldValue.serverTimestamp(),
  });
  return res.status(201).json({ success: true, reportId: ref.id, message: 'Report submitted for marketplace admin review.' });
}

export async function admin(req, res) {
  const adminUser = await requireAdmin(req);
  if (req.method === 'GET') {
    const status = clean(req.query?.status || 'OPEN').toUpperCase();
    if (!['OPEN', 'UNDER_REVIEW', 'RESOLVED', 'DISMISSED', 'ALL'].includes(status)) throw clientError('Invalid report status.');
    let query = adminDb.collection('sellerMarketplaceReports');
    if (status !== 'ALL') query = query.where('status', '==', status);
    const snapshot = await query.limit(200).get();
    const reports = snapshot.docs.map(doc => serialize({ id: doc.id, ...doc.data() }))
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    return res.status(200).json({ reports });
  }
  if (req.method !== 'PATCH') return methodNotAllowed(res, 'GET, PATCH');
  const id = clean(req.body?.id);
  const status = clean(req.body?.status).toUpperCase();
  const note = clean(req.body?.adminNote).slice(0, 1000);
  if (!id || id.length > 150) throw clientError('A valid report ID is required.');
  if (!['UNDER_REVIEW', 'RESOLVED', 'DISMISSED'].includes(status)) throw clientError('Choose a valid review status.');
  if (status === 'DISMISSED' && note.length < 3) throw clientError('Add a short reason when dismissing a report.');
  const ref = adminDb.collection('sellerMarketplaceReports').doc(id);
  const snapshot = await ref.get();
  if (!snapshot.exists) throw clientError('Report not found.', 404);
  const before = snapshot.data() || {};
  await ref.update({ status, adminNote: note, reviewedBy: adminUser.uid, updatedAt: FieldValue.serverTimestamp() });
  await adminDb.collection('sellerMarketplaceAudit').add({
    action: 'MARKETPLACE_REPORT_REVIEWED', reportId: id, productId: before.productId,
    sellerUid: before.sellerUid, actorUid: adminUser.uid, status, adminNote: note,
    createdAt: FieldValue.serverTimestamp(),
  });
  return res.status(200).json({ success: true, status });
}

export default create;
