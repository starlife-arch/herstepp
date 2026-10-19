import { adminDb, requireUser } from '../firebase-admin.js';
import { clientError, methodNotAllowed } from '../http.js';

const clean = value => String(value ?? '').trim();
const allowedCategories = new Set(['shoes', 'dresses', 'watches', 'necklaces', 'handbags', 'bags', 'accessories', 'other']);

function serialize(doc) {
  if (!doc?.exists) return null;
  const d = doc.data();
  return {
    id: doc.id,
    displayName: d.displayName,
    businessName: d.businessName,
    phone: d.phone,
    categories: Array.isArray(d.categories) ? d.categories : [],
    description: d.description || '',
    status: d.status || 'PENDING',
    adminReason: d.adminReason || '',
    createdAt: d.createdAt?.toDate?.().toISOString?.() ?? null,
    updatedAt: d.updatedAt?.toDate?.().toISOString?.() ?? null,
  };
}

export default async function sellerApplication(req, res) {
  const user = await requireUser(req);
  const ref = adminDb.collection('sellerApplications').doc(user.uid);

  if (req.method === 'GET') {
    const snap = await ref.get();
    return res.json({ application: serialize(snap) });
  }
  if (req.method !== 'POST') return methodNotAllowed(res, 'GET, POST');

  const displayName = clean(req.body?.displayName).slice(0, 60);
  const businessName = clean(req.body?.businessName).slice(0, 100);
  const phone = clean(req.body?.phone).slice(0, 24);
  const description = clean(req.body?.description).slice(0, 500);
  const categories = [...new Set((Array.isArray(req.body?.categories) ? req.body.categories : [])
    .map(clean).filter(category => allowedCategories.has(category)).slice(0, 8))];
  if (displayName.length < 2) throw clientError('Enter a seller display name (at least 2 characters).');
  if (!phone || !/^[+0-9()\s-]{7,24}$/.test(phone)) throw clientError('Enter a valid contact phone number.');
  if (!categories.length) throw clientError('Choose at least one product category.');
  if (req.body?.termsAccepted !== true) throw clientError('Accept the seller terms before applying.');

  const now = new Date();
  const profileSnap = await adminDb.collection('users').doc(user.uid).get();
  const profile = profileSnap.data() || {};
  const applicantEmail = clean(user.email || profile.email).toLowerCase().slice(0, 254);
  const payload = {
    applicantUid: user.uid,
    applicantEmail,
    displayName,
    businessName,
    phone,
    categories,
    description,
    termsAccepted: true,
    termsVersion: 'marketplace-application-v1',
    status: 'PENDING',
    adminReason: '',
    createdAt: now,
    updatedAt: now,
  };

  await adminDb.runTransaction(async tx => {
    const current = await tx.get(ref);
    if (current.exists && ['PENDING', 'APPROVED'].includes(current.data()?.status)) {
      throw clientError('You already have a pending or approved seller application.');
    }
    if (current.exists && current.data()?.status === 'SUSPENDED') {
      throw clientError('Your seller account is suspended. Contact HerStep support.');
    }
    tx.set(ref, { ...payload, createdAt: current.exists ? current.data()?.createdAt || now : now });
  });
  const saved = await ref.get();
  return res.status(201).json({ application: serialize(saved), message: 'Seller application submitted for admin review.' });
}
