import { adminDb, requireUser } from '../firebase-admin.js';
import { methodNotAllowed } from '../http.js';

const iso = value => value?.toDate?.().toISOString?.() ?? null;

function serializeApplication(snap) {
  if (!snap?.exists) return null;
  const d = snap.data() || {};
  return {
    displayName: d.displayName || '',
    status: d.status || 'PENDING',
    adminReason: d.adminReason || '',
    createdAt: iso(d.createdAt),
    updatedAt: iso(d.updatedAt),
  };
}

function serializeSeller(snap) {
  if (!snap?.exists) return null;
  const d = snap.data() || {};
  return {
    displayName: d.displayName || '',
    businessName: d.businessName || '',
    status: d.status || 'PENDING',
    planCode: d.planCode || 'STARTER',
    billingStatus: d.billingStatus || 'NOT_CONFIGURED',
    verificationBadge: d.verificationBadge === true,
    createdAt: iso(d.createdAt),
    updatedAt: iso(d.updatedAt),
  };
}

export default async function sellerDashboard(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
  const user = await requireUser(req);
  const [applicationSnap, sellerSnap] = await Promise.all([
    adminDb.collection('sellerApplications').doc(user.uid).get(),
    adminDb.collection('sellers').doc(user.uid).get(),
  ]);
  return res.json({
    application: serializeApplication(applicationSnap),
    seller: serializeSeller(sellerSnap),
  });
}
