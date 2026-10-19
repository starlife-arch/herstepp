import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, PackageCheck, RefreshCw, Truck } from 'lucide-react';
import { Button, Card } from '../components/ui';
import { apiFetch } from '../lib/api';
import { usePageMeta } from '../hooks/usePageMeta';

type SellerOrder = {
  id: string; orderDocumentId: string; orderId: string; status: string; statusUpdatedAt?: string | null;
  statusNote?: string; paymentStatus: string; createdAt?: string | null; sellerTotal: number;
  buyer: { name: string; email: string; phone: string; deliveryMethod: string; location: string; instructions: string };
  items: { productId: string; name: string; imageUrl: string; size: string; quantity: number; unitPrice: number; lineTotal: number }[];
};
const nextStatus: Record<string, string> = {
  PENDING: 'PROCESSING', PROCESSING: 'PROCESSED', PROCESSED: 'OUT_FOR_DELIVERY', OUT_FOR_DELIVERY: 'DELIVERED',
};
const label = (value: string) => value.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, char => char.toUpperCase());
const money = (value: number) => new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES', maximumFractionDigits: 0 }).format(Number(value) || 0);

export default function SellerOrders() {
  usePageMeta('Marketplace Orders | HerStep Seller', 'Manage fulfilment for products sold through your marketplace shop.');
  const [orders, setOrders] = useState<SellerOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const result: any = await apiFetch('/api/sellers/orders');
      setOrders(Array.isArray(result.orders) ? result.orders : []);
    } catch (err: any) {
      setError(err?.message || 'Could not load your marketplace orders.');
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  async function updateStatus(order: SellerOrder) {
    const next = nextStatus[order.status];
    if (!next) return;
    setBusyId(order.id); setError(''); setNotice('');
    try {
      const result: any = await apiFetch('/api/sellers/orders', {
        method: 'PATCH',
        body: JSON.stringify({ orderDocumentId: order.orderDocumentId, status: next, note: (notes[order.id] || '').trim() }),
      });
      setNotice(result.message || 'Fulfilment updated.');
      await load();
    } catch (err: any) {
      setError(err?.message || 'Could not update this order.');
    } finally { setBusyId(''); }
  }

  return <main className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
    <Link to="/seller/dashboard" className="inline-flex items-center gap-2 text-sm text-neutral-600 hover:text-neutral-900 mb-5"><ArrowLeft className="w-4 h-4" /> Seller dashboard</Link>
    <div className="flex flex-wrap items-start justify-between gap-3 mb-7">
      <div><p className="text-xs font-semibold tracking-wide text-neutral-500">HERSTEP MARKETPLACE</p><h1 className="text-3xl font-bold mt-1">My marketplace orders</h1><p className="text-sm text-neutral-600 mt-2">Manage fulfilment only for products sold by your business. HerStep admins do not update your seller fulfilment status.</p></div>
      <Button variant="outline" onClick={() => void load()} disabled={loading}><RefreshCw className="w-4 h-4 mr-2" /> Refresh</Button>
    </div>
    {notice && <div role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 mb-4">{notice}</div>}
    {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 mb-4">{error}</div>}
    {loading ? <Card className="p-8 text-center text-sm text-neutral-500">Loading marketplace orders…</Card> : orders.length === 0 ? <Card className="p-8 text-center"><PackageCheck className="w-9 h-9 mx-auto text-neutral-400 mb-2" /><p className="font-semibold">No marketplace orders yet</p><p className="text-sm text-neutral-500 mt-1">Paid orders containing your products will appear here.</p></Card> : <div className="space-y-4">
      {orders.map(order => {
        const next = nextStatus[order.status];
        return <Card key={order.id} className="p-5 sm:p-6">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><p className="text-xs text-neutral-500">Order reference</p><h2 className="text-lg font-bold">{order.orderId}</h2><p className="text-sm text-neutral-600 mt-1">Placed {order.createdAt ? new Date(order.createdAt).toLocaleString('en-KE') : 'date unavailable'}</p></div>
            <div className="text-right"><p className="text-xl font-bold">{money(order.sellerTotal)}</p><p className="text-xs text-neutral-500">Your products · Payment {label(order.paymentStatus)}</p><span className="inline-flex rounded-full bg-neutral-100 px-3 py-1 text-xs font-semibold mt-2">{label(order.status)}</span></div>
          </div>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-5 mt-5">
            <section><h3 className="text-sm font-semibold mb-3">Your items in this order</h3><div className="space-y-3">{order.items.map((item, index) => <div key={item.productId + '-' + index} className="flex items-center gap-3">{item.imageUrl && <img src={item.imageUrl} alt={item.name} className="w-14 h-14 rounded-lg object-cover bg-neutral-100" />}<div className="min-w-0 flex-1"><p className="font-medium text-sm">{item.name}</p><p className="text-xs text-neutral-500">Variant {item.size || '—'} · Qty {item.quantity}</p></div><p className="text-sm font-semibold">{money(item.lineTotal)}</p></div>)}</div></section>
            <section className="rounded-lg bg-neutral-50 p-4"><h3 className="text-sm font-semibold mb-2">Buyer and delivery details</h3><p className="text-sm">{order.buyer.name}</p><p className="text-sm text-neutral-600">{order.buyer.phone || 'No phone provided'}</p><p className="text-sm text-neutral-600 break-all">{order.buyer.email || 'No email provided'}</p><p className="text-sm text-neutral-600 mt-2">{label(order.buyer.deliveryMethod)}{order.buyer.location ? ' · ' + order.buyer.location : ''}</p>{order.buyer.instructions && <p className="text-xs text-neutral-500 mt-2">Instructions: {order.buyer.instructions}</p>}</section>
          </div>
          {next && <div className="border-t border-neutral-100 mt-5 pt-4"><label className="block text-xs font-medium text-neutral-700 mb-1" htmlFor={'seller-order-note-' + order.id}>Fulfilment note (optional)</label><input id={'seller-order-note-' + order.id} value={notes[order.id] || ''} onChange={event => setNotes(current => ({ ...current, [order.id]: event.target.value }))} maxLength={500} className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm mb-3" placeholder="e.g. Packed and ready for dispatch" /><Button disabled={busyId === order.id} onClick={() => void updateStatus(order)}><Truck className="w-4 h-4 mr-2" />{busyId === order.id ? 'Updating…' : 'Mark ' + label(next)}</Button></div>}
          {order.status === 'DELIVERED' && <p className="mt-4 text-sm text-emerald-700 font-medium">Delivered. Eligible earnings have moved to your available balance, subject to any refund holds.</p>}
        </Card>;
      })}
    </div>}
  </main>;
}
