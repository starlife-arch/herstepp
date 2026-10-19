import React, { useCallback, useEffect, useState } from 'react';
import { Star, ThumbsUp, ThumbsDown } from 'lucide-react';
import { onAuthStateChanged } from 'firebase/auth';
import { apiFetch } from '../lib/api';
import { getFirebase } from '../lib/firebase';
import { Card, Button } from './ui';

type Review = {
  id: string;
  rating: number;
  title?: string;
  comment: string;
  customerName: string;
  verifiedPurchase: boolean;
  createdAt?: string | null;
  helpfulCount?: number;
  notHelpfulCount?: number;
  photos?: string[];
};

export function ProductReviews({ productId }: { productId: string }) {
  const [reviews, setReviews] = useState<Review[]>([]);
  const [average, setAverage] = useState<number | null>(null);
  const [count, setCount] = useState(0);
  const [rating, setRating] = useState(5);
  const [title, setTitle] = useState('');
  const [comment, setComment] = useState('');
  const [photos, setPhotos] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);
  const [photoFilter, setPhotoFilter] = useState(false);
  const [ratingFilter, setRatingFilter] = useState('ALL');
  const [sortBy, setSortBy] = useState('newest');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [signedIn, setSignedIn] = useState(false);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [voting, setVoting] = useState<string | null>(null);

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

  const voteOnReview = async (review: Review, vote: 'helpful' | 'notHelpful') => {
    if (!signedIn) { setMessage({ text: 'Sign in to vote on a review.', error: true }); return; }
    setVoting(review.id); setMessage(null);
    try {
      const result: any = await apiFetch('/api/reviews', { method: 'POST', body: JSON.stringify({ action: 'vote', reviewId: review.id, vote }) });
      setReviews(current => current.map(item => item.id === review.id ? { ...item, helpfulCount: result.helpfulCount, notHelpfulCount: result.notHelpfulCount } : item));
      setMessage({ text: 'Your vote has been recorded.', error: false });
    } catch (error: any) { setMessage({ text: error?.message || 'Your vote could not be saved.', error: true }); }
    finally { setVoting(null); }
  };

  const uploadPhotos = async (files: FileList | null) => {
    if (!files?.length) return;
    const selected = Array.from(files).slice(0, Math.max(0, 3 - photos.length));
    if (!selected.length) { setMessage({ text: 'You can attach up to 3 photos per review.', error: true }); return; }
    setUploading(true); setMessage(null);
    try {
      const uploaded: string[] = [];
      for (const file of selected) {
        if (file.size > 5 * 1024 * 1024) throw new Error('Each photo must be 5 MB or smaller.');
        const signature: any = await apiFetch('/api/reviews/sign-upload', {
          method: 'POST',
          body: JSON.stringify({ fileName: file.name, bytes: file.size, mimeType: file.type }),
        });
        const form = new FormData();
        form.append('file', file);
        form.append('api_key', signature.apiKey);
        form.append('timestamp', String(signature.timestamp));
        form.append('signature', signature.signature);
        form.append('folder', signature.folder);
        form.append('public_id', signature.publicId);
        form.append('allowed_formats', signature.allowedFormats.join(','));
        const response = await fetch('https://api.cloudinary.com/v1_1/' + signature.cloudName + '/image/upload', { method: 'POST', body: form });
        const result: any = await response.json();
        if (!response.ok || !result.secure_url) throw new Error('A photo could not be uploaded. Please try again.');
        uploaded.push(result.secure_url);
      }
      setPhotos(current => [...current, ...uploaded].slice(0, 3));
    } catch (error: any) {
      setMessage({ text: error?.message || 'Photo upload failed.', error: true });
    } finally { setUploading(false); }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setMessage(null);
    try {
      const result: any = await apiFetch('/api/reviews', {
        method: 'POST',
        body: JSON.stringify({ productId, rating, title, comment, photos }),
      });
      setMessage({ text: result.message || 'Review submitted for approval.', error: false });
      setTitle('');
      setComment('');
      setPhotos([]);
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
            <div>
              <label className="block text-sm font-medium text-neutral-800 mb-1" htmlFor={`review-photos-${productId}`}>Customer photos (optional, up to 3)</label>
              <input id={`review-photos-${productId}`} type="file" accept="image/jpeg,image/png,image/webp,image/avif" multiple onChange={event => { void uploadPhotos(event.target.files); event.currentTarget.value = ''; }} disabled={uploading || photos.length >= 3} className="block w-full text-sm text-neutral-600 file:mr-3 file:rounded-lg file:border-0 file:bg-neutral-100 file:px-3 file:py-2" />
              <p className="mt-1 text-xs text-neutral-500">JPEG, PNG, WebP or AVIF, up to 5 MB each. Photos appear after approval.</p>
              {uploading && <p className="mt-2 text-xs text-neutral-500">Uploading photos…</p>}
              {photos.length > 0 && <div className="mt-2 flex flex-wrap gap-2">{photos.map((url, index) => <div key={url} className="relative"><img src={url} alt={`Review upload ${index + 1}`} className="h-16 w-16 rounded-lg border object-cover" /><button type="button" onClick={() => setPhotos(current => current.filter(item => item !== url))} className="absolute -right-2 -top-2 rounded-full bg-neutral-900 px-1.5 text-xs text-white" aria-label="Remove photo">×</button></div>)}</div>}
            </div>
            <Button type="submit" disabled={submitting || uploading || comment.trim().length < 5}>{submitting ? 'Submitting…' : 'Submit review'}</Button>
          </form>
        </Card>
      )}

      {message && <p role="status" className={`text-sm ${message.error ? 'text-red-700' : 'text-emerald-700'}`}>{message.text}</p>}
      {!loading && reviews.length > 0 && <div className="flex flex-wrap items-center gap-3">
        <label className="text-xs text-neutral-600">Rating <select value={ratingFilter} onChange={event => setRatingFilter(event.target.value)} className="ml-2 rounded-lg border border-neutral-300 bg-white px-2 py-2 text-sm"><option value="ALL">All</option><option value="5">5 stars</option><option value="4">4 stars</option><option value="3">3 stars</option><option value="2">2 stars</option><option value="1">1 star</option></select></label>
        <label className="flex items-center gap-2 text-sm text-neutral-700"><input type="checkbox" checked={photoFilter} onChange={event => setPhotoFilter(event.target.checked)} /> With photos</label>
        <label className="text-xs text-neutral-600">Sort <select value={sortBy} onChange={event => setSortBy(event.target.value)} className="ml-2 rounded-lg border border-neutral-300 bg-white px-2 py-2 text-sm"><option value="newest">Newest</option><option value="highest">Highest rating</option><option value="lowest">Lowest rating</option><option value="helpful">Most helpful</option></select></label>
      </div>}
      {loading ? <p className="text-sm text-neutral-500">Loading reviews…</p> : reviews.length === 0 ? (
        <Card className="p-5 text-sm text-neutral-500">No approved reviews yet. If you purchased this product, sign in to share your experience.</Card>
      ) : (
        <div className="space-y-3">
          {reviews.filter(review => (ratingFilter === 'ALL' || review.rating === Number(ratingFilter)) && (!photoFilter || Boolean(review.photos?.length))).slice().sort((a, b) => sortBy === 'highest' ? b.rating - a.rating : sortBy === 'lowest' ? a.rating - b.rating : sortBy === 'helpful' ? (b.helpfulCount || 0) - (a.helpfulCount || 0) : String(b.createdAt || '').localeCompare(String(a.createdAt || ''))).map(review => (
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
              {!!review.photos?.length && <div className="mt-3 flex flex-wrap gap-2">{review.photos.map((url, index) => <a key={url} href={url} target="_blank" rel="noreferrer" aria-label={`Open customer photo ${index + 1}`}><img src={url} alt={`Customer review photo ${index + 1}`} loading="lazy" className="h-20 w-20 rounded-lg border border-neutral-200 object-cover" /></a>)}</div>}
              <div className="mt-4 border-t border-neutral-100 pt-3">
                <p className="text-xs font-medium text-neutral-600 mb-2">Was this helpful?</p>
                <div className="flex flex-wrap gap-2">
                  <button type="button" onClick={() => void voteOnReview(review, 'helpful')} disabled={voting === review.id} className="inline-flex items-center gap-2 rounded-lg border border-neutral-200 px-3 py-2 text-sm text-neutral-700 hover:bg-neutral-50 disabled:opacity-50" aria-label="Like this review"><ThumbsUp className="h-4 w-4" /> Like <span className="text-neutral-500">({review.helpfulCount || 0})</span></button>
                  <button type="button" onClick={() => void voteOnReview(review, 'notHelpful')} disabled={voting === review.id} className="inline-flex items-center gap-2 rounded-lg border border-neutral-200 px-3 py-2 text-sm text-neutral-700 hover:bg-neutral-50 disabled:opacity-50" aria-label="Dislike this review"><ThumbsDown className="h-4 w-4" /> Dislike <span className="text-neutral-500">({review.notHelpfulCount || 0})</span></button>
                </div>
                {!signedIn && <p className="mt-2 text-xs text-neutral-500">Sign in to vote. One vote per review; you can change it later.</p>}
              </div>
            </Card>
          ))}
        </div>
      )}

    </section>
  );
}
