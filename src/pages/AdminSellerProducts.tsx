import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, RefreshCw, ShieldCheck, Store, XCircle } from 'lucide-react';
import { Badge, Button, Card, EmptyState, Input, getStatusBadge, formatDateTime } from '../components/ui';
import { apiFetch } from '../lib/api';
import { usePageMeta } from '../hooks/usePageMeta';

type SellerProduct = {
  id: string; sellerUid: string; sellerDisplayName?: string; name: string; description?: string;
  categoryId: string; sku: string; price: number; salePrice?: number | null; status: string;
  inventory?: { size: string; quantity: number; costPrice?: number | null }[];
  images?: { url: string; publicId: string; resourceType: string }[];
  stockQuantity?: number; updatedAt?: string; moderationReason?: string; publishedProductId?: string;
};
const money = (amount: number) => new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES', maximumFractionDigits: 0 }).format(amount);
const filters = [
  { value: 'ALL', label: 'All listings' }, { value: 'PENDING_REVIEW', label: 'Submitted — awaiting review' }, { value: 'DRAFT', label: 'Private drafts' },
  { value: 'APPROVED', label: 'Approved — private' }, { value: 'PUBLISHED', label: 'Published' },
  { value: 'REJECTED', label: 'Rejected' },
];

export default function AdminSellerProducts() {
  usePageMeta('Seller Product Moderation | HerStep Admin', 'Review seller marketplace product listings.');
  const [status, setStatus] = useState('PENDING_REVIEW');
  const [products, setProducts] = useState<SellerProduct[]>([]);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const result: any = await apiFetch('/api/admin/seller-products?status=' + encodeURIComponent(status));
      setProducts(Array.isArray(result.products) ? result.products : []);
    } catch (err: any) { setError(err?.message || 'Could not load seller listings.'); }
    finally { setLoading(false); }
  }, [status]);
  useEffect(() => { void load(); }, [load]);

  async function moderate(product: SellerProduct, action: 'APPROVE' | 'REJECT' | 'PUBLISH') {
    const reason = reasons[product.id] || '';
    if (action === 'REJECT' && reason.trim().length < 3) { setError('Add a reason of at least 3 characters before rejecting.'); return; }
    setBusyId(product.id); setError(''); setNotice('');
    try {
      const result: any = await apiFetch('/api/admin/seller-products', {
        method: 'PATCH', body: JSON.stringify({ id: product.id, action, reason }),
      });
      setNotice(result.message || 'Listing updated.');
      await load();
    } catch (err: any) { setError(err?.message || 'Could not update this listing.'); }
    finally { setBusyId(''); }
  }

  return <div className="min-h-screen bg-neutral-50"><div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
    <Link to="/admin" className="inline-flex items-center gap-2 text-sm text-neutral-500 hover:text-neutral-900 mb-5"><ArrowLeft className="w-4 h-4" /> Back to admin dashboard</Link>
    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-8">
      <div><p className="text-xs font-semibold tracking-wide text-neutral-500 mb-2">MARKETPLACE ADMIN</p><h1 className="text-3xl font-bold text-neutral-900">Seller product moderation</h1>
      <p className="text-sm text-neutral-600 mt-2">Review each listing before it reaches the public catalogue. Publishing re-checks seller status, subscription expiry and plan limits.</p></div>
      <Button variant="outline" onClick={load} loading={loading}><RefreshCw className="w-4 h-4 mr-2" /> Refresh</Button>
    </div>
    <Card className="p-4 mb-6"><div className="flex flex-col sm:flex-row sm:items-center gap-3">
      <label htmlFor="seller-product-filter" className="text-sm font-medium text-neutral-700">Listing status</label>
      <select id="seller-product-filter" value={status} onChange={e => setStatus(e.target.value)} className="w-full sm:w-72 px-3 py-2.5 border border-neutral-300 rounded-lg bg-white text-sm">
        {filters.map(filter => <option key={filter.value} value={filter.value}>{filter.label}</option>)}
      </select><span className="text-sm text-neutral-500 sm:ml-auto">{products.length} shown (maximum 200)</span>
    </div></Card>
    {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 mb-4">{error}</div>}
    {notice && <div role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700 mb-4">{notice}</div>}
    {loading ? <Card className="p-8 text-center text-sm text-neutral-500">Loading seller listings…</Card> : products.length === 0 ?
      <Card><EmptyState title="No seller listings found" description={status === 'PENDING_REVIEW' ? 'Submitted seller listings will appear here for review.' : status === 'DRAFT' ? 'Private drafts are not yet submitted by their sellers.' : 'Try another listing status filter.'} /></Card> :
      <div className="space-y-4">{products.map(product => {
        const badge = getStatusBadge(product.status);
        const busy = busyId === product.id;
        return <Card key={product.id} className="p-5 sm:p-6"><div className="flex flex-col lg:flex-row gap-5">
          {product.images?.[0]?.url && <img src={product.images[0].url} alt={product.name} className="w-full lg:w-40 h-40 object-cover rounded-lg bg-neutral-100" loading="lazy" />}
          <div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><Store className="w-4 h-4 text-neutral-500" /><h2 className="text-lg font-semibold text-neutral-900">{product.name}</h2><Badge variant={badge.variant}>{badge.label}</Badge></div>
            <p className="text-sm text-neutral-600 mt-1">Seller: {product.sellerDisplayName || product.sellerUid}</p>
            <p className="text-sm text-neutral-700 mt-2">{product.description || 'No description provided.'}</p>
            <p className="text-sm font-semibold mt-2">{money(product.salePrice ?? product.price)}{product.salePrice != null && <span className="ml-2 line-through text-neutral-400 font-normal">{money(product.price)}</span>}</p>
            <p className="text-xs text-neutral-500 mt-1">SKU: {product.sku} · Stock: {product.stockQuantity ?? (product.inventory || []).reduce((n, i) => n + i.quantity, 0)} · Updated {product.updatedAt ? formatDateTime(product.updatedAt) : 'recently'}</p>
            {product.moderationReason && <p className="text-sm text-rose-700 mt-2">Reason: {product.moderationReason}</p>}
            <div className="mt-4 max-w-xl"><Input label="Decision reason / note" value={reasons[product.id] ?? product.moderationReason ?? ''} onChange={e => setReasons(old => ({ ...old, [product.id]: e.target.value }))} maxLength={500} placeholder="Required when rejecting" /></div>
            <div className="flex flex-wrap gap-2 mt-3">
              {['DRAFT', 'PENDING_REVIEW', 'REJECTED'].includes(product.status) && <Button size="sm" loading={busy} disabled={Boolean(busyId && !busy)} onClick={() => moderate(product, 'APPROVE')}><ShieldCheck className="w-4 h-4 mr-1.5" /> Approve listing</Button>}
              {['DRAFT', 'PENDING_REVIEW', 'APPROVED', 'REJECTED'].includes(product.status) && <Button size="sm" variant="danger" loading={busy} disabled={Boolean(busyId && !busy)} onClick={() => moderate(product, 'REJECT')}><XCircle className="w-4 h-4 mr-1.5" /> Reject</Button>}
              {product.status === 'APPROVED' && <Button size="sm" loading={busy} disabled={Boolean(busyId && !busy)} onClick={() => moderate(product, 'PUBLISH')}><CheckCircle2 className="w-4 h-4 mr-1.5" /> Publish publicly</Button>}
              {product.status === 'PUBLISHED' && product.publishedProductId && <Link to={'/product/' + encodeURIComponent(product.publishedProductId)} className="inline-flex items-center text-sm font-medium underline">View public listing</Link>}
            </div>
          </div>
        </div></Card>;
      })}</div>}
  </div></div>;
}
