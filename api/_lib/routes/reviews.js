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
      .limit(100)
      .get();
    const reviews = snap.docs.filter(doc => doc.data().status === 'APPROVED').map(doc => {
      const d = doc.data();
      return {
        id: doc.id,
        helpfulCount: Number(d.helpfulCount) || 0,
        notHelpfulCount: Number(d.notHelpfulCount) || 0,
        productId: d.productId,
        rating: d.rating,
        title: d.title ?? '',
        comment: d.comment ?? '',
        photos: Array.isArray(d.photos) ? d.photos.filter(url => typeof url === 'string').slice(0, 3) : [],
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

  if (req.method === 'POST' && req.body?.action === 'vote') {
    const user = await requireUser(req);
    const reviewId = clean(req.body?.reviewId);
    const vote = clean(req.body?.vote);
    if (!/^[a-f0-9]{64}$/.test(reviewId)) throw clientError('Invalid review.');
    if (!['helpful', 'notHelpful'].includes(vote)) throw clientError('Choose Like or Dislike.');
    const reviewRef = adminDb.collection('reviews').doc(reviewId);
    const voteRef = reviewRef.collection('votes').doc(user.uid);
    const counts = await adminDb.runTransaction(async tx => {
      const reviewSnap = await tx.get(reviewRef);
      const voteSnap = await tx.get(voteRef);
      if (!reviewSnap.exists || reviewSnap.data().status !== 'APPROVED') throw clientError('This review is not available for voting.', 404);
      if (reviewSnap.data().customerId === user.uid) throw clientError('You cannot vote on your own review.');
      const previous = voteSnap.exists ? voteSnap.data().vote : null;
      let helpfulCount = Number(reviewSnap.data().helpfulCount) || 0;
      let notHelpfulCount = Number(reviewSnap.data().notHelpfulCount) || 0;
      if (previous === vote) return { helpfulCount, notHelpfulCount, currentVote: previous };
      if (previous === 'helpful') helpfulCount = Math.max(0, helpfulCount - 1);
      if (previous === 'notHelpful') notHelpfulCount = Math.max(0, notHelpfulCount - 1);
      if (vote === 'helpful') helpfulCount += 1;
      else notHelpfulCount += 1;
      tx.set(voteRef, { userId: user.uid, vote, updatedAt: new Date() });
      tx.update(reviewRef, { helpfulCount, notHelpfulCount, updatedAt: new Date() });
      return { helpfulCount, notHelpfulCount, currentVote: vote };
    });
    return res.json(counts);
  }

  if (req.method === 'POST') {
    const user = await requireUser(req);
    const productId = clean(req.body?.productId);
    const rating = Number(req.body?.rating);
    const title = clean(req.body?.title).slice(0, 100);
    const comment = clean(req.body?.comment).slice(0, 2000);
    const photos = Array.isArray(req.body?.photos) ? [...new Set(req.body.photos.filter(url => typeof url === 'string').map(url => url.trim()))].slice(0, 3) : [];
    const cloudName = String(process.env.CLOUDINARY_CLOUD_NAME || '').trim();
    const validPhotoUrl = url => {
      try {
        const parsed = new URL(url);
        return parsed.protocol === 'https:' && parsed.hostname === 'res.cloudinary.com' && parsed.pathname.startsWith('/' + cloudName + '/image/upload/') && url.length <= 1200;
      } catch { return false; }
    };
    if (!cloudName && photos.length) throw clientError('Photo uploads are not configured.', 503);
    if (photos.some(url => !validPhotoUrl(url))) throw clientError('Review photos must be uploaded through HerStep’s secure photo uploader.');
    if (!productId || productId.length > 160) throw clientError('A valid product is required.');
    if (!Number.isInteger(rating) || rating < 1 || rating > 5) throw clientError('Choose a rating from 1 to 5.');
    if (comment.length < 5) throw clientError('Please write at least 5 characters about your experience.');

    const existing = await adminDb.collection('reviews').doc(reviewIdFor(productId, user.uid)).get();
    if (existing.exists) throw clientError('You have already submitted a review for this product.', 409);

    // Only a successful, paid order containing this product qualifies.
    const orders = await adminDb.collection('orders')
      .where('customerId', '==', user.uid)
      .limit(100)
      .get();
    const purchased = orders.docs.some(doc =>
      String(doc.data().paymentStatus).toUpperCase() === 'PAID' &&
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
      photos,
      verifiedPurchase: true,
      status: 'PENDING',
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    await adminDb.collection('reviews').doc(reviewIdFor(productId, user.uid)).create(review);
    return res.status(201).json({
      message: 'Thank you. Your review has been submitted for approval.',
      review: { productId, rating, title, comment, photos, status: 'PENDING', verifiedPurchase: true },
    });
  }

  return methodNotAllowed(res, 'GET, POST');
}
