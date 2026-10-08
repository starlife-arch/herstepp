import React, { useEffect, useMemo, useState } from 'react';
import { useSearchParams, Link } from 'react-router-dom';
import { Search, Package, Check, Truck, Clock, MapPin, Heart, FileText } from 'lucide-react';
import { Card, Button, Badge, formatCurrency, formatDate, formatDateTime, getStatusBadge, EmptyState } from '../components/ui';
import { apiFetch, apiDownload } from '../lib/api';
import { usePageMeta } from '../hooks/usePageMeta';

import { useApp } from '../context/AppContext';

// Real data only: GET /api/orders/track (server-verified, owner-only).
// No state.orders lookup — the page never crashes when data is missing.
type TrackOrder = {
  id: string;
  orderId: string;
  orderStatus: string;
  paymentStatus: string;
  customerName?: string;
  receiptNumber?: string | null;
  invoiceNumber?: string | null;
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

// "Download invoice" outline button for the signed-in owner of a PAID order.
// Errors are shown inline — no alert/confirm/popups.
function InvoiceDownloadButton({ order }: { order: TrackOrder }) {
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const invoiceNumber = String(order.invoiceNumber || '').trim()
    || String(order.orderId || '').replace(/^HS-/, 'INV-');
  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiDownload(
        `/api/invoices/download?orderDocumentId=${encodeURIComponent(order.id)}`,
        `HerStep-Invoice-${invoiceNumber}.pdf`,
      );
    } catch (e: any) {
      setError(e?.message || 'We could not download your invoice.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card className="p-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-full bg-neutral-100 flex items-center justify-center shrink-0">
            <FileText className="w-5 h-5 text-neutral-600" />
          </div>
          <div>
            <p className="font-medium text-sm text-neutral-900">Invoice {invoiceNumber}</p>
            <p className="text-xs text-neutral-500">A PDF copy of your paid invoice.</p>
          </div>
        </div>
        <Button variant="outline" size="sm" onClick={download} disabled={busy}>
          <FileText className="w-4 h-4 mr-2" />
          {busy ? 'Preparing…' : `Download invoice ${invoiceNumber}`}
        </Button>
      </div>
      {error && <p role="alert" className="text-xs text-red-600 mt-3">{error}</p>}
    </Card>
  );
}

export default function OrderTracking() {
  usePageMeta('Track Your Order | HerStep Collection', "Track any HerStep order or M-Pesa receipt — live status from checkout to delivery.");
  const [searchParams] = useSearchParams();
  const { state } = useApp();
  // One input accepts an order number (HS-...) OR a receipt number (HSP-...).
  const initial = searchParams.get('order') || searchParams.get('orderId') || searchParams.get('receipt') || '';
  const [searchId, setSearchId] = useState(initial);
  const [order, setOrder] = useState<TrackOrder | null>(null);
  const [loading, setLoading] = useState(false);
  const [searched, setSearched] = useState(false);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function fetchOrder(id: string) {
    if (!id.trim()) return;
    setLoading(true);
    setError(null);
    setNotFound(false);
    setSearched(true);
    try {
      const data = await apiFetch(`/api/orders/track?order=${encodeURIComponent(id.trim())}`);
      setOrder(data?.order ?? null);
    } catch (err: any) {
      setOrder(null);
      const msg = String(err?.message || '');
      // The server answers 404 "We couldn't find that order on your account"
      // both for unknown numbers and for orders owned by someone else.
      if (msg.includes("couldn't find") || err?.status === 404) setNotFound(true);
      else setError(msg || 'We could not load this order.');
    } finally {
      setLoading(false);
    }
  }

  // Auto-search when arriving with ?order=... / ?orderId=... / ?receipt=...
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
      <p className="text-neutral-500 text-sm mb-8">Enter your order number (HS-...) or receipt number (HSP-...) to check the status of your order.</p>

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
              placeholder="Order or receipt number (e.g., HS-2026-000001)"
              className="w-full pl-10 pr-4 py-3 border border-neutral-300 rounded-xl text-sm focus:border-neutral-900"
            />
          </div>
          <Button type="submit" disabled={loading || !searchId.trim()}>{loading ? 'Tracking…' : 'Track'}</Button>
        </div>
      </form>

      {loading && <Card className="p-8 text-center text-sm text-neutral-500 animate-pulse">Loading your order…</Card>}

      {!loading && notFound && (
        <Card className="p-8 space-y-4 text-center">
          <EmptyState
            title="Order not found"
            description={
              state.user
                ? "We couldn't find that order on your account. Check the number you entered — orders belong to the account that placed them."
                : 'Sign in with the account that placed the order, then try again.'
            }
          />
          {!state.user && (
            <Link to="/login"><Button variant="outline" size="sm">Sign in</Button></Link>
          )}
        </Card>
      )}

      {!loading && !notFound && searched && error && (
        <Card className="p-6 border-red-200 bg-red-50">
          <p className="font-semibold text-red-700 mb-1">We could not load this order</p>
          <p className="text-sm text-red-600 mb-3">{error}</p>
          <Button size="sm" variant="outline" onClick={() => void fetchOrder(searchId)}>Retry</Button>
        </Card>
      )}

      {!loading && !error && !notFound && order && (
        <div className="space-y-6 animate-fadeIn">
          {/* Order Header */}
          <Card className="p-6">
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
              <div>
                <p className="text-sm text-neutral-500">Order Number</p>
                <p className="text-xl font-bold text-neutral-900">{order.orderId}</p>
                {order.customerName && <p className="text-xs text-neutral-500 mt-1">Placed by {order.customerName}</p>}
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
              {order.receiptNumber && (
                <div>
                  <p className="text-neutral-500">Receipt</p>
                  <p className="font-medium">{order.receiptNumber}</p>
                </div>
              )}
            </div>
            {order.delivery?.phone && (
              <div className="mt-3 text-sm">
                <span className="text-neutral-500">Phone: </span>
                <span className="font-medium">{order.delivery.phone}</span>
                {order.delivery.fullName && <span className="text-neutral-500"> · {order.delivery.fullName}</span>}
              </div>
            )}
            {order.delivery?.instructions && (
              <div className="mt-2 p-3 bg-neutral-50 rounded-lg text-sm">
                <p className="text-xs text-neutral-500 mb-0.5">Delivery instructions</p>
                <p className="text-neutral-900">{order.delivery.instructions}</p>
              </div>
            )}
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

          {/* Invoice download — signed-in owner of a PAID order only. The
              server re-checks ownership + payment state on every request. */}
          {state.user && String(order.paymentStatus).toUpperCase() === 'PAID' && (
            <InvoiceDownloadButton order={order} />
          )}

          {/* Treat the team — shown once the order is delivered */}
          {order.orderStatus === 'DELIVERED' && (
            <Card className="p-5">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <div className="w-10 h-10 rounded-full bg-rose-50 flex items-center justify-center shrink-0">
                    <Heart className="w-5 h-5 text-rose-500" />
                  </div>
                  <div>
                    <p className="font-medium text-sm text-neutral-900">Happy with your order? Treat the team</p>
                    <p className="text-xs text-neutral-500">A small thank-you goes a long way in Juja.</p>
                  </div>
                </div>
                <Link to="/tip">
                  <Button size="sm">Treat the team</Button>
                </Link>
              </div>
            </Card>
          )}
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
