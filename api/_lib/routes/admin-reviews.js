import { adminDb, requireAdmin } from '../firebase-admin.js';
import { clientError, methodNotAllowed } from '../http.js';

const iso = value => value?.toDate?.().toISOString?.() ?? value ?? null;

export default async function adminReviews(req, res) {
  const admin = await requireAdmin(req);

  if (req.method === 'GET') {
    const rawStatus = Array.isArray(req.query.status) ? req.query.status[0] : req.query.status;
    const status = typeof rawStatus === 'string' && rawStatus
      ? rawStatus.toUpperCase()
      : 'PENDING';
    if (!['PENDING', 'APPROVED', 'REJECTED', 'ALL'].includes(status)) {
      throw clientError('Invalid review status.');
    }
    let query = adminDb.collection('reviews');
    if (status !== 'ALL') query = query.where('status', '==', status);
    const snap = await query.limit(100).get();
    const reviews = snap.docs.map(doc => {
      const d = doc.data();
      return {
        id: doc.id,
        productId: d.productId,
        customerId: d.customerId,
        customerName: d.customerName || 'Customer',
        rating: d.rating,
        title: d.title || '',
        comment: d.comment || '',
        status: d.status || 'PENDING',
        verifiedPurchase: d.verifiedPurchase === true,
        createdAt: iso(d.createdAt),
      };
    }).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    return res.json({ reviews });
  }

  if (req.method === 'PATCH') {
    const reviewId = String(req.body?.reviewId || '').trim();
    const status = String(req.body?.status || '').trim().toUpperCase();
    if (!/^[a-f0-9]{64}$/.test(reviewId)) throw clientError('Invalid review ID.');
    if (!['APPROVED', 'REJECTED'].includes(status)) {
      throw clientError('Choose APPROVED or REJECTED.');
    }
    const ref = adminDb.collection('reviews').doc(reviewId);
    const snap = await ref.get();
    if (!snap.exists) throw clientError('Review not found.', 404);
    await ref.update({
      status,
      moderatedAt: new Date(),
      moderatedBy: admin.uid,
      updatedAt: new Date(),
    });
    return res.json({ message: status === 'APPROVED' ? 'Review approved.' : 'Review rejected.', reviewId, status });
  }

  return methodNotAllowed(res, 'GET, PATCH');
}
