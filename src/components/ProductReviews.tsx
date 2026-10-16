import React, { useCallback, useEffect, useState } from 'react';
import { Star } from 'lucide-react';
import { onAuthStateChanged } from 'firebase/auth';
import { apiFetch } from '../lib/api';
import { getFirebase } from '../lib/firebase';
import { Card, Button } from './ui';

const SAMPLE_REVIEW_TEMPLATES = [
  { title: 'Example: Everyday style', comment: 'Illustrative sample text: I like how a versatile shoe style can work with different everyday outfits.', rating: 5 },
  { title: 'Example: Occasion wear', comment: 'Illustrative sample text: A dressy pair can be a useful option for celebrations and special occasions.', rating: 4 },
  { title: 'Example: Fit and comfort', comment: 'Illustrative sample text: Checking the size guide and fit details helps me choose a pair with confidence.', rating: 5 },
  { title: 'Example: Styling ideas', comment: 'Illustrative sample text: I would style a pair like this with both casual and smarter outfits.', rating: 4 },
  { title: 'Example: Choosing a pair', comment: 'Illustrative sample text: Clear photos, available sizes and product details make choosing easier.', rating: 5 },
];

function getSampleReviews(productId: string) {
  const seed = Array.from(productId).reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return [0, 1].map(offset => SAMPLE_REVIEW_TEMPLATES[(seed + offset * 2) % SAMPLE_REVIEW_TEMPLATES.length]);
}

type Review = {
  id: string;
  rating: number;
  title?: string;
  comment: string;
  customerName: string;
  verifiedPurchase: boolean;
  createdAt?: string | null;
};

export function ProductReviews({ productId }: { productId: string }) {
  const [reviews, setReviews] = useState<Review[]>([]);
  const [average, setAverage] = useState<number | null>(null);
  const [count, setCount] = useState(0);
  const [rating, setRating] = useState(5);
  const [title, setTitle] = useState('');
  const [comment, setComment] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);

  const loadReviews = useCallback(async () => {
    setLoading(true);
    try {
      const result: any = await apiFetch(`/api/reviews?productId=${encodeURIComponent(productId)}`);
      setReviews(Array.isArray(result.reviews) ? result.reviews : []);
      setAverage(typeof result.averageRating === 'number' ? result.averageRating : null);
      setCount(Number(result.count) || 0);
    } catch (error: any) {
      setMessage({ text: error?.message || 'Reviews could not be loaded right now.', error: true });
    } finally {
      setLoading(false);
    }
  }, [productId]);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let active = true;
    getFirebase().then(({ auth }) => {
      if (!active) return;
      unsubscribe = onAuthStateChanged(auth, user => setSignedIn(Boolean(user)));
    }).catch(() => undefined);
    void loadReviews();
    return () => { active = false; unsubscribe?.(); };
  }, [loadReviews]);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setMessage(null);
    try {
      const result: any = await apiFetch('/api/reviews', {
        method: 'POST',
        body: JSON.stringify({ productId, rating, title, comment }),
      });
      setMessage({ text: result.message || 'Review submitted for approval.', error: false });
      setTitle('');
      setComment('');
    } catch (error: any) {
      setMessage({ text: error?.message || 'Your review could not be submitted.', error: true });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="mt-12 space-y-5" aria-labelledby="product-reviews-heading">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 id="product-reviews-heading" className="text-2xl font-bold text-neutral-900">Customer Reviews</h2>
          <p className="mt-1 text-sm text-neutral-500">Reviews are from verified purchasers and appear after approval.</p>
        </div>
        <div className="text-sm text-neutral-600">
          {average !== null ? <span className="font-semibold text-neutral-900">{average.toFixed(1)} / 5</span> : 'Not rated yet'}
          <span className="ml-2">({count} {count === 1 ? 'review' : 'reviews'})</span>
        </div>
      </div>

      {signedIn && (
        <Card className="p-5">
          <form onSubmit={submit} className="space-y-4">
            <h3 className="font-semibold text-neutral-900">Share your experience</h3>
            <p className="text-xs text-neutral-500">You must have paid for this product using your account. One review per product.</p>
            <div>
              <label className="block text-sm font-medium text-neutral-800 mb-2" htmlFor={`review-rating-${productId}`}>Your rating</label>
              <div className="flex items-center gap-1" id={`review-rating-${productId}`}>
                {[1, 2, 3, 4, 5].map(value => (
                  <button key={value} type="button" onClick={() => setRating(value)} aria-label={`${value} star${value === 1 ? '' : 's'}`} aria-pressed={rating === value} className="p-1 rounded focus:outline-none focus:ring-2 focus:ring-neutral-500">
                    <Star className={`h-6 w-6 ${value <= rating ? 'fill-amber-400 text-amber-500' : 'text-neutral-300'}`} />
                  </button>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-neutral-800 mb-1" htmlFor={`review-title-${productId}`}>Title (optional)</label>
              <input id={`review-title-${productId}`} value={title} onChange={event => setTitle(event.target.value)} maxLength={100} className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm" placeholder="A short headline" />
            </div>
            <div>
              <label className="block text-sm font-medium text-neutral-800 mb-1" htmlFor={`review-comment-${productId}`}>Your review</label>
              <textarea id={`review-comment-${productId}`} value={comment} onChange={event => setComment(event.target.value)} required minLength={5} maxLength={2000} rows={4} className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm" placeholder="How did the shoes fit? How was the quality?" />
            </div>
            <Button type="submit" disabled={submitting || comment.trim().length < 5}>{submitting ? 'Submitting…' : 'Submit review'}</Button>
          </form>
        </Card>
      )}

      {message && <p role="status" className={`text-sm ${message.error ? 'text-red-700' : 'text-emerald-700'}`}>{message.text}</p>}
      {loading ? <p className="text-sm text-neutral-500">Loading reviews…</p> : reviews.length === 0 ? (
        <Card className="p-5 text-sm text-neutral-500">No approved reviews yet. If you have purchased this product, sign in to be the first to review it.</Card>
      ) : (
        <div className="space-y-3">
          {reviews.map(review => (
            <Card key={review.id} className="p-5">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-semibold text-neutral-900">{review.title || 'Customer review'}</p>
                  <p className="mt-1 text-xs text-neutral-500">{review.customerName} · Verified purchase{review.createdAt ? ` · ${new Date(review.createdAt).toLocaleDateString()}` : ''}</p>
                </div>
                <div className="flex items-center gap-1 shrink-0" aria-label={`${review.rating} out of 5 stars`}>
                  {Array.from({ length: 5 }, (_, index) => <Star key={index} className={`h-4 w-4 ${index < review.rating ? 'fill-amber-400 text-amber-500' : 'text-neutral-300'}`} />)}
                </div>
              </div>
              <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-neutral-700">{review.comment}</p>
            </Card>
          ))}
        </div>
      )}

      <div className="space-y-3">
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-4">
          <p className="text-sm font-semibold text-amber-900">Sample reviews — examples only</p>
          <p className="mt-1 text-xs leading-relaxed text-amber-800">These illustrative examples are not real customer feedback, are not verified purchases, and are excluded from the product's review count and average rating. Real customer reviews appear separately after moderation.</p>
        </div>
        {getSampleReviews(productId).map((sample, index) => (
          <Card key={`sample-${productId}-${index}`} className="border-dashed p-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <span className="inline-flex rounded bg-amber-100 px-2 py-1 text-[10px] font-bold uppercase tracking-wide text-amber-900">Sample only</span>
                <p className="mt-2 font-semibold text-neutral-900">{sample.title}</p>
                <p className="mt-1 text-xs text-neutral-500">Illustrative example · Not a customer review</p>
              </div>
              <div className="flex items-center gap-1 shrink-0" aria-label={`Example rating: ${sample.rating} out of 5`}>
                {Array.from({ length: 5 }, (_, index) => <Star key={index} className={`h-4 w-4 ${index < sample.rating ? 'fill-amber-400 text-amber-500' : 'text-neutral-300'}`} />)}
              </div>
            </div>
            <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-neutral-700">{sample.comment}</p>
          </Card>
        ))}
      </div>
    </section>
  );
}
