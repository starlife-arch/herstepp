import React, { useCallback, useEffect, useState } from 'react';
import { Star } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { Badge, Button, Card } from './ui';

type Review = {
  id: string;
  productId: string;
  customerName: string;
  rating: number;
  title?: string;
  comment: string;
  status: string;
  verifiedPurchase: boolean;
  createdAt?: string | null;
};

export function AdminReviews() {
  const [status, setStatus] = useState('PENDING');
  const [reviews, setReviews] = useState<Review[]>([]);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; error: boolean } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setNotice(null);
    try {
      const result: any = await apiFetch(`/api/admin/reviews?status=${status}`);
      setReviews(Array.isArray(result.reviews) ? result.reviews : []);
    } catch (error: any) {
      setNotice({ text: error?.message || 'Could not load reviews.', error: true });
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => { void load(); }, [load]);

  const moderate = async (reviewId: string, nextStatus: 'APPROVED' | 'REJECTED') => {
    setWorking(reviewId);
    setNotice(null);
    try {
      await apiFetch('/api/admin/reviews', {
        method: 'PATCH',
        body: JSON.stringify({ reviewId, status: nextStatus }),
      });
      setNotice({ text: nextStatus === 'APPROVED' ? 'Review approved and now visible on the product page.' : 'Review rejected.', error: false });
      await load();
    } catch (error: any) {
      setNotice({ text: error?.message || 'Could not update this review.', error: true });
    } finally {
      setWorking(null);
    }
  };

  return (
    <div className="space-y-6 animate-fadeIn">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-neutral-900">Product Reviews</h1>
          <p className="mt-1 text-sm text-neutral-500">Only reviews from customers with a paid order can be submitted. Approve a review before it appears publicly.</p>
        </div>
        <Button variant="outline" onClick={() => void load()} disabled={loading}>Refresh</Button>
      </div>
      <div className="flex flex-wrap gap-2">
        {[['PENDING', 'Pending'], ['APPROVED', 'Approved'], ['REJECTED', 'Rejected'], ['ALL', 'All reviews']].map(([value, label]) => (
          <button key={value} type="button" onClick={() => setStatus(value)} className={`rounded-lg border px-3 py-2 text-sm ${status === value ? 'border-neutral-900 bg-neutral-900 text-white' : 'border-neutral-300 bg-white text-neutral-700'}`}>{label}</button>
        ))}
      </div>
      {notice && <p role="status" className={`text-sm ${notice.error ? 'text-red-700' : 'text-emerald-700'}`}>{notice.text}</p>}
      {loading ? <Card className="p-8 text-center text-sm text-neutral-500">Loading reviews…</Card> : reviews.length === 0 ? (
        <Card className="p-8 text-center text-sm text-neutral-500">No reviews in this view.</Card>
      ) : (
        <div className="space-y-3">
          {reviews.map(review => (
            <Card key={review.id} className="p-5">
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="font-semibold text-neutral-900">{review.title || 'Customer review'}</h2>
                    <Badge variant={review.status === 'APPROVED' ? 'success' : review.status === 'REJECTED' ? 'danger' : 'warning'}>{review.status}</Badge>
                    {review.verifiedPurchase && <Badge variant="info">Verified purchase</Badge>}
                  </div>
                  <p className="mt-1 text-xs text-neutral-500">{review.customerName} · Product ID: {review.productId}{review.createdAt ? ` · ${new Date(review.createdAt).toLocaleDateString()}` : ''}</p>
                  <div className="mt-2 flex items-center gap-1" aria-label={`${review.rating} out of 5 stars`}>
                    {Array.from({ length: 5 }, (_, index) => <Star key={index} className={`h-4 w-4 ${index < review.rating ? 'fill-amber-400 text-amber-500' : 'text-neutral-300'}`} />)}
                  </div>
                  <p className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-neutral-700">{review.comment}</p>
                </div>
                {review.status !== 'APPROVED' && (
                  <div className="flex shrink-0 gap-2">
                    <Button size="sm" onClick={() => void moderate(review.id, 'APPROVED')} disabled={working !== null}>{working === review.id ? 'Saving…' : 'Approve'}</Button>
                    {review.status !== 'REJECTED' && <Button size="sm" variant="danger" onClick={() => void moderate(review.id, 'REJECTED')} disabled={working !== null}>Reject</Button>}
                  </div>
                )}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}
