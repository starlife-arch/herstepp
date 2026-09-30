import React, { useEffect, useMemo, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { Search, Package, Check, Truck, Clock, MapPin } from 'lucide-react';
import { Card, Button, Badge, formatCurrency, formatDate, formatDateTime, getStatusBadge, EmptyState } from '../components/ui';
import { apiFetch } from '../lib/api';

// Real data only: GET /api/orders/track (server-verified, owner-only).
// No state.orders lookup — the page never crashes when data is missing.
type TrackOrder = {
  id: string;
  orderId: string;
  orderStatus: string;
  paymentStatus: string;
  subtotal: number;
  deliveryFee: number;
  discount: number;
  total: number;
  createdAt: string | null;
  delivery: { fullName: string; phone: string; deliveryMethod: string; location: string; instructions: string };
  items: { productId: string; name: string; size: string; quantity: number; unitPrice: number; lineTotal: number; imageUrl: string | null }[];
  history: { newStatus?: string; previousStatus?: string | null; note?: string; createdAt: string | null }[];
};

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export default function OrderTracking() {
  const [searchParams] = useSearchParams();
  const initial = searchParams.get('orderId') || '';
  const [searchId, setSearchId] = useState(initial);
  const [order, setOrder] = useState<TrackOrder | null>(null);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function fetchOrder(id: string) {
    if (!id.trim()) return;
    setLoading(true);
    setError(null);
    setSearched(true);
    try {
      const data = await apiFetch(`/api/orders/track?orderId=${encodeURIComponent(id.trim())}`);
      setOrder(data?.order ?? null);
    } catch (err: any) {
      setOrder(null);
      // 404 = "not found" message; anything else = visible error card.
      setError(err?.message || 'We could not load this order.');
    } finally {
      setLoading(false);
    }
  }

  // Auto-search when arriving with ?orderId=... (e.g. after checkout).
  useEffect(() => {
    if (initial.trim()) void fetchOrder(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const statusSteps = useMemo(
    () => [
      { status: 'PENDING', label: 'Order Placed', icon: Package },
      { status: 'PROCESSING', label: 'Processing', icon: Clock },
      { status: 'PROCESSED', label: 'Processed', icon: Check },
      { status: 'OUT_FOR_DELIVERY', label: 'Out for Delivery', icon: Truck },
      { status: 'DELIVERED', label: 'Delivered', icon: MapPin },
    ],
    [],
  );

  const getStepIndex = (status: string) => statusSteps.findIndex(s => s.status === status);

  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-8 animate-fadeIn">
      <h1 className="text-2xl font-bold text-neutral-900 mb-2">Track Your Order</h1>
      <p className="text-neutral-500 text-sm mb-8">Enter your order ID to check the status of your order.</p>

      {/* Search */}
      <form
        onSubmit={e => {
          e.preventDefault();
          void fetchOrder(searchId);
        }}
        className="mb-8"
      >
        <div className="flex gap-3">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-neutral-400" />
            <input
              type="text"
              value={searchId}
              onChange={e => setSearchId(e.target.value)}
              placeholder="Enter order ID (e.g., HS-2026-000001)"
              className="w-full pl-10 pr-4 py-3 border border-neutral-300 rounded-xl text-sm focus:border-neutral-900"
            />
          </div>
          <Button type="submit" disabled={loading || !searchId.trim()}>{loading ? 'Tracking…' : 'Track'}</Button>
        </div>
      </form>

      {loading && <Card className="p-8 text-center text-sm text-neutral-500 animate-pulse">Loading your order…</Card>}

      {!loading && searched && error && (
        <Card className="p-8 space-y-4 text-center">
          <EmptyState title="Order not found" description={error.includes('not found') || error.includes('Not signed') ? error : 'We could not find an order with that ID. Please check and try again.'} />
          <p className="text-xs text-neutral-500">You must be signed in with the account that placed the order.</p>
          <Link to="/login"><Button variant="outline" size="sm">Sign in</Button></Link>
        </Card>
      )}

      {!loading && !error && order && (
        <div className="space-y-6 animate-fadeIn">
          {/* Order Header */}
          <Card className="p-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
              <div>
                <p className="text-sm text-neutral-500">Order ID</p>
                <p className="text-xl font-bold text-neutral-900">{order.orderId}</p>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={getStatusBadge(order.paymentStatus).variant}>Payment: {getStatusBadge(order.paymentStatus).label}</Badge>
                <Badge variant={getStatusBadge(order.orderStatus).variant}>{getStatusBadge(order.orderStatus).label}</Badge>
              </div>
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
              <div>
                <p className="text-neutral-500">Date</p>
                <p className="font-medium">{order.createdAt ? formatDate(order.createdAt) : '—'}</p>
              </div>
              <div>
                <p className="text-neutral-500">Total</p>
                <p className="font-medium">{formatCurrency(num(order.total))}</p>
              </div>
              <div>
                <p className="text-neutral-500">Delivery</p>
                <p className="font-medium capitalize">{order.delivery?.deliveryMethod === 'DELIVERY' ? 'Delivery' : 'Collection'}</p>
              </div>
              <div>
                <p className="text-neutral-500">Location</p>
                <p className="font-medium">{order.delivery?.location || '—'}</p>
              </div>
            </div>
          </Card>

          {/* Timeline */}
          <Card className="p-6">
            <h3 className="font-semibold text-neutral-900 mb-6">Order Timeline</h3>
            {order.orderStatus === 'CANCELLED' ? (
              <div className="flex items-center gap-3 p-4 bg-red-50 border border-red-100 rounded-lg text-sm text-red-700">
                <XCircleIcon /> This order was cancelled.
              </div>
            ) : (
              <div className="relative">
                {statusSteps.map((step, i) => {
                  const currentIdx = getStepIndex(order.orderStatus);
                  const isCompleted = i <= currentIdx;
                  const isCurrent = i === currentIdx;
                  const historyEntry = (Array.isArray(order.history) ? order.history : []).find(h => h.newStatus === step.status);

                  return (
                    <div key={step.status} className="flex gap-4 mb-6 last:mb-0">
                      <div className="flex flex-col items-center">
                        <div className={`w-10 h-10 rounded-full flex items-center justify-center ${isCompleted ? 'bg-neutral-900 text-white' : 'bg-neutral-100 text-neutral-400'}`}>
                          <step.icon className="w-4 h-4" />
                        </div>
                        {i < statusSteps.length - 1 && (
                          <div className={`w-0.5 h-8 mt-2 ${isCompleted && i < currentIdx ? 'bg-neutral-900' : 'bg-neutral-200'}`} />
                        )}
                      </div>
                      <div className="pt-2">
                        <p className={`font-medium text-sm ${isCompleted ? 'text-neutral-900' : 'text-neutral-400'}`}>{step.label}</p>
                        {historyEntry?.createdAt && (
                          <p className="text-xs text-neutral-500 mt-0.5">{formatDateTime(historyEntry.createdAt)}</p>
                        )}
                        {isCurrent && (
                          <p className="text-xs text-neutral-600 mt-0.5 font-medium">Current status</p>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          {/* Order Items */}
          <Card className="p-6">
            <h3 className="font-semibold text-neutral-900 mb-4">Order Items</h3>
            <div className="space-y-3">
              {(Array.isArray(order.items) ? order.items : []).map((item, i) => (
                <div key={i} className="flex items-center gap-3 p-3 bg-neutral-50 rounded-lg">
                  <img
                    src={item.imageUrl || PLACEHOLDER}
                    alt=""
                    className="w-12 h-12 rounded-lg object-cover"
                    onError={e => { (e.currentTarget as HTMLImageElement).src = PLACEHOLDER; }}
                  />
                  <div className="flex-1">
                    <p className="font-medium text-sm text-neutral-900">{item.name}</p>
                    <p className="text-xs text-neutral-500">Size {item.size} | Qty {item.quantity}</p>
                  </div>
                  <span className="font-medium text-sm">{formatCurrency(num(item.lineTotal))}</span>
                </div>
              ))}
            </div>
            <div className="mt-4 pt-4 border-t border-neutral-200 space-y-2">
              <div className="flex justify-between text-sm"><span className="text-neutral-500">Subtotal</span><span>{formatCurrency(num(order.subtotal))}</span></div>
              <div className="flex justify-between text-sm"><span className="text-neutral-500">Delivery</span><span>{num(order.deliveryFee) === 0 ? 'Free' : formatCurrency(num(order.deliveryFee))}</span></div>
              {num(order.discount) > 0 && <div className="flex justify-between text-sm"><span className="text-neutral-500">Discount</span><span className="text-emerald-600">-{formatCurrency(num(order.discount))}</span></div>}
              <div className="flex justify-between font-semibold pt-2 border-t border-neutral-200"><span>Total</span><span>{formatCurrency(num(order.total))}</span></div>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}

const PLACEHOLDER =
  'data:image/svg+xml;utf8,' +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="48" height="48"><rect width="48" height="48" fill="#f5f5f5"/><path d="M14 32l8-9 5 5 7-8v16H14z" fill="#d4d4d4"/></svg>',
  );

function XCircleIcon() {
  return (
    <svg className="w-5 h-5 shrink-0" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="12" r="10" /><path d="M15 9l-6 6M9 9l6 6" />
    </svg>
  );
}
