import { createHash } from 'node:crypto';
import { adminDb, requireUser } from '../firebase-admin.js';
import { clientError, methodNotAllowed } from '../http.js';

const clean = value => String(value ?? '').trim();
const reviewIdFor = (productId, uid) =>
  createHash('sha256').update(`${uid}: ${productId}`).digest('hex');

export default async function reviews(req, res) {
  if (req.method === 'GET') {
    const productId = clean(Array.isArray(req.query.productId) ? req.query.productId[0] : req.query.productId);
    if (!productId || productId.length > 160) throw clientError('A valid product is required.');
    const snap = await adminDb.collection('reviews')
      .where('productId', '==', productId)
      .where('status', '==', 'APPROVED')
      .limit(100)
      .get();
    const reviews = snap.docs.map(doc => {
      const d = doc.data();
      return {
        id: doc.id,
        productId: d.productId,
        rating: d.rating,
        title: d.title ?? '',
        comment: d.comment ?? '',
        customerName: d.customerName || 'Verified customer',
        verifiedPurchase: true,
        createdAt: d.createdAt?.toDate?.().toISOString?.() ?? null,
      };
    }).sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    const averageRating = reviews.length
      ? Math.round((reviews.reduce((sum, review) => sum + review.rating, 0) / reviews.length) * 10) / 10
      : null;
    return res.json({ reviews, count: reviews.length, averageRating });
  }

  if (req.method === 'POST') {
    const user = await requireUser(req);
    const productId = clean(req.body?.productId);
    const rating = Number(req.body?.rating);
    const title = clean(req.body?.title).slice(0, 100);
    const comment = clean(req.body?.comment).slice(0, 2000);
    if (!productId || productId.length > 160) throw clientError('A valid product is required.');
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw clientError('Choose a rating from 1 to 5.');
    if (comment.length < 5) throw clientError('Please write at least 5 characters about your experience.');

    const existing = await adminDb.collection('reviews').doc(reviewIdFor(productId, user.uid)).get();
    if (existing.exists) throw clientError('You have already submitted a review for this product.', 409);

    // Only a successful, paid order containing this product qualifies.
    const orders = await adminDb.collection('orders')
      .where('customerId', '==', user.uid)
      .where('paymentStatus', '==', 'PAID')
      .limit(100)
      .get();
    const purchased = orders.docs.some(doc =>
      Array.isArray(doc.data().items) &&
      doc.data().items.some(item => String(item.productId) === productId && Number(item.quantity) > 0)
    );
    if (!purchased) throw clientError('Reviews are available only to customers who purchased this product.', 403);

    const userSnap = await adminDb.collection('users').doc(user.uid).get();
    const profile = userSnap.data() || {};
    const customerName = clean(profile.displayName || profile.name || profile.fullName || user.name || 'Verified customer').slice(0, 80);
    const review = {
      productId,
      customerId: user.uid,
      customerName,
      rating,
      title,
      comment,
      verifiedPurchase: true,
      status: 'PENDING',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await adminDb.collection('reviews').doc(reviewIdFor(productId, user.uid)).create(review);
    return res.status(201).json({
      message: 'Thank you. Your review has been submitted for approval.',
      review: { productId, rating, title, comment, status: 'PENDING', verifiedPurchase: true },
    });
  }

  return methodNotAllowed(res, 'GET, POST');
}
