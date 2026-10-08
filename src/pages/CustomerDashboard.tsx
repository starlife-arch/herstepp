import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { usePageMeta } from '../hooks/usePageMeta';

import { LayoutDashboard, ShoppingBag, CreditCard, MessageSquare, Bell, User, LogOut, Package, FileText, ChevronRight, Heart } from 'lucide-react';
import { useApp, markNotificationReadOnServer } from '../context/AppContext';
import { Card, Badge, Button, formatCurrency, formatDate, formatDateTime, getStatusBadge, EmptyState } from '../components/ui';
import { productImageUrl, orderItemImageUrl } from '../lib/productImage';
import { apiFetch, apiDownload } from '../lib/api';

// Real data only. GET /api/dashboard already returns ONLY the signed-in
// customer's orders/payments/notifications (server filters by the verified
// uid). No client-side uid matching, no mock ids, no lowercase statuses.
const up = (s: unknown) => String(s ?? '').toUpperCase();
const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);

export default function CustomerDashboard() {
  usePageMeta('My Account | HerStep Collection');
  const { state, logout, reloadDashboard } = useApp();
  const navigate = useNavigate();
  const [activeTab, setActiveTab] = useState('overview');

  if (!state.user) {
    navigate('/login');
    return null;
  }

  const userOrders: any[] = Array.isArray(state.orders) ? state.orders : [];
  const pendingOrders = userOrders.filter(o => ['PENDING', 'PROCESSING'].includes(up(o.orderStatus)));
  const completedOrders = userOrders.filter(o => up(o.orderStatus) === 'DELIVERED');
  const unreadNotifs = state.notifications.filter(n => !n.read);
  // Polling: only while the tab is visible AND a payment is PENDING. We poll
  // GET /api/payments/status for the pending payment ids only (never the full
  // dashboard), back off 5 s, 10 s, 20 s, 30 s and stop after 3 minutes. When
  // a status changes we refetch the dashboard once. No background polling.
  const pendingPaymentIds = userOrders
    .filter(order => up(order.paymentStatus) === 'PENDING' && order.paymentId)
    .map(order => String(order.paymentId));
  useEffect(() => {
    if (pendingPaymentIds.length === 0) return;
    const ids = pendingPaymentIds;
    const started = Date.now();
    const delays = [5000, 10000, 20000, 30000];
    let cancelled = false;
    let timer = 0;
    let step = 0;
    const tick = async () => {
      if (cancelled) return;
      if (Date.now() - started > 180_000 || document.visibilityState !== 'visible') {
        if (Date.now() - started <= 180_000) {
          // Hidden tab: skip this round but keep the window alive.
          timer = window.setTimeout(tick, delays[Math.min(step, delays.length - 1)]);
        }
        return;
      }
      try {
        const results = await Promise.all(ids.map((id: string) => apiFetch(`/api/payments/status?paymentId=${encodeURIComponent(id)}`)));
        const changed = results.some((res: any) => up(res?.payment?.status) !== 'PENDING');
        if (changed) void reloadDashboard();
      } catch { /* transient: keep backing off */ }
      step += 1;
      if (!cancelled && Date.now() - started <= 180_000) {
        timer = window.setTimeout(tick, delays[Math.min(step, delays.length - 1)]);
      }
    };
    timer = window.setTimeout(tick, delays[0]);
    const onVisible = () => { if (document.visibilityState === 'visible') void tick(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [reloadDashboard, pendingPaymentIds.join(',')]);

  const tabs = [
    { id: 'overview', label: 'Overview', icon: LayoutDashboard },
    { id: 'orders', label: 'My Orders', icon: Package },
    { id: 'payments', label: 'Payments', icon: CreditCard },
    { id: 'support', label: 'Support', icon: MessageSquare },
    { id: 'notifications', label: 'Notifications', icon: Bell },
    { id: 'profile', label: 'Profile', icon: User },
  ];

  // Loading and error states come straight from the server fetch status in
  // AppContext — the visible message is the server's own error text.
  let content: React.ReactNode;
  if (state.dashboardLoading && userOrders.length === 0) {
    content = <Card className="p-8 text-center text-sm text-neutral-500 animate-pulse">Loading your account…</Card>;
  } else if (state.dashboardError) {
    content = (
      <Card className="p-6 border-red-200 bg-red-50">
        <p className="font-semibold text-red-700 mb-1">We could not load your account</p>
        <p className="text-sm text-red-600 mb-3">{state.dashboardError}</p>
        <Button size="sm" variant="outline" onClick={() => window.location.reload()}>Retry</Button>
      </Card>
    );
  } else if (activeTab === 'overview') {
    content = <OverviewTab orders={userOrders} pendingOrders={pendingOrders} completedOrders={completedOrders} />;
  } else if (activeTab === 'orders') {
    content = <OrdersTab orders={userOrders} />;
  } else if (activeTab === 'payments') {
    content = <PaymentsTab orders={userOrders} />;
  } else if (activeTab === 'support') {
    content = <SupportTab />;
  } else if (activeTab === 'notifications') {
    content = <NotificationsTab />;
  } else {
    content = <ProfileTab />;
  }

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 animate-fadeIn">
      {/* Same yellow banner as Checkout — state.emailVerified comes from
          GET /api/dashboard (profile.emailVerified, server-maintained). */}
      {!state.emailVerified && (
        <div className="mb-6 p-3 rounded-lg bg-yellow-50 border border-yellow-200 flex items-center justify-between gap-3">
          <p className="text-sm text-yellow-800">Verify your email to place orders</p>
          <Link to="/verify-email">
            <Button size="sm" variant="secondary">Verify now</Button>
          </Link>
        </div>
      )}
      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6">
        {/* Sidebar */}
        <aside className="lg:col-span-1">
          <Card className="p-4">
            <div className="flex items-center gap-3 p-3 mb-4 border-b border-neutral-100">
              <div className="w-10 h-10 bg-neutral-900 rounded-full flex items-center justify-center">
                <span className="text-white font-medium text-sm">{(state.user.name || '?').charAt(0)}</span>
              </div>
              <div>
                <p className="font-medium text-sm text-neutral-900">{state.user.name}</p>
                <p className="text-xs text-neutral-500">{state.user.email}</p>
              </div>
            </div>
            <nav className="space-y-1">
              {tabs.map(tab => (
                <button
                  key={tab.id}
                  onClick={() => setActiveTab(tab.id)}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${activeTab === tab.id ? 'bg-neutral-100 text-neutral-900' : 'text-neutral-600 hover:bg-neutral-50'}`}
                >
                  <tab.icon className="w-4 h-4" />
                  {tab.label}
                  {tab.id === 'notifications' && unreadNotifs.length > 0 && (
                    <span className="ml-auto w-5 h-5 bg-red-500 text-white text-xs rounded-full flex items-center justify-center">{unreadNotifs.length}</span>
                  )}
                </button>
              ))}
              <Link
                to="/tip"
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-neutral-600 hover:bg-neutral-50"
              >
                <Heart className="w-4 h-4" />
                Treat the team
              </Link>
              <hr className="my-2 border-neutral-100" />
              <button
                onClick={async () => { await logout(); navigate('/'); }}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-neutral-600 hover:bg-neutral-50"
              >
                <LogOut className="w-4 h-4" />
                Logout
              </button>
            </nav>
          </Card>
        </aside>

        {/* Content */}
        <main className="lg:col-span-3">{state.dashboardWarnings.length > 0 && <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 space-y-1">{state.dashboardWarnings.map((w, i) => <p key={i}>{String(w)}</p>)}</div>}{content}</main>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview — counts + total spent from PAID orders only.
// ---------------------------------------------------------------------------
function OverviewTab({ orders, pendingOrders, completedOrders }: any) {
  const paidOrders = orders.filter((o: any) => up(o.paymentStatus) === 'PAID');
  const totalSpent = paidOrders.reduce((s: number, o: any) => s + num(o.total), 0);
  return (
    <div className="space-y-6">
      <h2 className="text-xl font-bold text-neutral-900">Dashboard Overview</h2>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <StatCard label="Total Orders" value={orders.length} />
        <StatCard label="Pending" value={pendingOrders.length} />
        <StatCard label="Completed" value={completedOrders.length} />
        <StatCard label="Total Spent" value={formatCurrency(totalSpent)} />
      </div>
      <Card className="p-6">
        <h3 className="font-semibold text-neutral-900 mb-4">Recent Orders</h3>
        {orders.length === 0 ? (
          <EmptyState title="No orders yet" description="Your orders will appear here." action={<Link to="/shop"><Button size="sm">Start Shopping</Button></Link>} />
        ) : (
          <div className="space-y-3">
            {orders.slice(0, 5).map((order: any) => (
              <Link key={order.id} to={`/track?order=${encodeURIComponent(order.orderId)}`} className="flex items-center justify-between p-3 rounded-lg hover:bg-neutral-50 border border-neutral-100">
                <div>
                  <p className="font-medium text-sm text-neutral-900">Order {order.orderId}</p>
                  <p className="text-xs text-neutral-500">{formatDate(order.createdAt)}</p>
                </div>
                <div className="flex items-center gap-3">
                  <Badge variant={getStatusBadge(up(order.orderStatus)).variant}>{getStatusBadge(up(order.orderStatus)).label}</Badge>
                  <span className="font-medium text-sm">{formatCurrency(num(order.total))}</span>
                  <ChevronRight className="w-4 h-4 text-neutral-400" />
                </div>
              </Link>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}

// ---------------------------------------------------------------------------
// My Orders — full detail inline (accordion), so every item, fee, delivery
// note, receipt and status history is visible without a separate page.
// ---------------------------------------------------------------------------
function OrdersTab({ orders }: any) {
  const [openId, setOpenId] = useState<string | null>(null);
  const [filter, setFilter] = useState('all');
  const shownOrders = orders.filter((order: any) => filter === 'all' || (filter === 'unpaid' && up(order.paymentStatus) !== 'PAID') || (filter === 'paid' && up(order.paymentStatus) === 'PAID') || (filter === 'cancelled' && (up(order.paymentStatus) === 'CANCELLED' || up(order.orderStatus) === 'CANCELLED')));
  return (
    <div className="space-y-6">
      <h2 className="text-xl font-bold text-neutral-900">My Orders</h2>
      <div className="flex gap-2">{['all', 'unpaid', 'paid', 'cancelled'].map(value => <button key={value} onClick={() => setFilter(value)} className={`rounded-full px-3 py-1.5 text-sm ${filter === value ? 'bg-neutral-900 text-white' : 'bg-neutral-100 text-neutral-600'}`}>{value.charAt(0).toUpperCase() + value.slice(1)}</button>)}</div>
      {shownOrders.length === 0 ? (
        <Card className="p-8"><EmptyState title="No orders yet" description="Your order history will appear here." action={<Link to="/shop"><Button size="sm">Start Shopping</Button></Link>} /></Card>
      ) : (
        <div className="space-y-4">
          {shownOrders.map((order: any) => {
            const isOpen = openId === order.id;
            const items = Array.isArray(order.items) ? order.items : [];
            const history = Array.isArray(order.statusHistory) ? order.statusHistory : [];
            return (
              <Card key={order.id} className="p-5">
                <button type="button" onClick={() => setOpenId(isOpen ? null : order.id)} className="w-full text-left">
                  <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
                    <div>
                      <p className="font-semibold text-neutral-900">Order {order.orderId}</p>
                      <p className="text-xs text-neutral-500">{formatDateTime(order.createdAt)}</p>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant={getStatusBadge(up(order.paymentStatus)).variant}>{getStatusBadge(up(order.paymentStatus)).label}</Badge>
                      <Badge variant={getStatusBadge(up(order.orderStatus)).variant}>{getStatusBadge(up(order.orderStatus)).label}</Badge>
                      <span className="font-semibold text-sm ml-1">{formatCurrency(num(order.total))}</span>
                      <ChevronRight className={`w-4 h-4 text-neutral-400 transition-transform ${isOpen ? 'rotate-90' : ''}`} />
                    </div>
                  </div>
                </button>

                {isOpen && (
                  <div className="mt-4 pt-4 border-t border-neutral-100 space-y-5">
                    {/* Items with images and names (never product ids) */}
                    <div className="space-y-2">
                      {items.map((item: any, i: number) => (
                        <div key={i} className="flex items-center gap-3">
                          <img
                            src={orderItemImageUrl(item)}
                            alt={item.productName || item.name || 'Product'}
                            className="w-12 h-12 rounded-lg object-cover bg-neutral-100"
                            onError={e => { (e.currentTarget as HTMLImageElement).src = productImageUrl(null); }}
                          />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm font-medium text-neutral-900 truncate">{item.productName || item.name}</p>
                            <p className="text-xs text-neutral-500">Size {item.size} · Qty {item.quantity} × {formatCurrency(num(item.unitPrice))}</p>
                          </div>
                          <span className="text-sm font-medium">{formatCurrency(num(item.lineTotal ?? item.total))}</span>
                        </div>
                      ))}
                    </div>

                    {/* Totals */}
                    <div className="text-sm space-y-1 bg-neutral-50 rounded-lg p-3">
                      <div className="flex justify-between"><span className="text-neutral-500">Subtotal</span><span>{formatCurrency(num(order.subtotal))}</span></div>
                      <div className="flex justify-between"><span className="text-neutral-500">Delivery</span><span>{num(order.deliveryFee) === 0 ? 'Free' : formatCurrency(num(order.deliveryFee))}</span></div>
                      {num(order.discount) > 0 && <div className="flex justify-between"><span className="text-neutral-500">Discount</span><span className="text-emerald-600">-{formatCurrency(num(order.discount))}</span></div>}
                      <div className="flex justify-between font-semibold pt-1 border-t border-neutral-200"><span>Total</span><span>{formatCurrency(num(order.total))}</span></div>
                    </div>

                    {/* Delivery details */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                      <InfoLine label="Method" value={up(order.delivery?.deliveryMethod) === 'DELIVERY' ? 'Delivery' : 'Collection'} />
                      <InfoLine label="Name" value={order.delivery?.fullName || order.customerName || '—'} />
                      <InfoLine label="Phone" value={order.delivery?.phone || '—'} />
                      <InfoLine label="Location" value={order.delivery?.location || '—'} />
                      {order.delivery?.instructions && <InfoLine label="Instructions" value={order.delivery.instructions} />}
                    </div>

                    {/* Payment info */}
                    <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
                      <InfoLine label="Payment" value={getStatusBadge(up(order.paymentStatus)).label} />
                      {up(order.paymentStatus) === 'PAID' && <InfoLine label="Receipt" value={order.receiptNumber || '—'} />}
                      {order.failureReason && <InfoLine label="Payment issue" value={order.failureReason} />}
                    </div>

                    {/* Status history timeline */}
                    {history.length > 0 && (
                      <div>
                        <p className="text-sm font-semibold text-neutral-900 mb-2">Status History</p>
                        <ul className="space-y-1.5">
                          {history.map((h: any, i: number) => (
                            <li key={i} className="flex items-center gap-2 text-xs text-neutral-600">
                              <span className="w-1.5 h-1.5 rounded-full bg-neutral-400 shrink-0" />
                              <span className="font-medium">{String(h.newStatus ?? '').replace(/_/g, ' ')}</span>
                              {h.note && <span className="text-neutral-400">— {h.note}</span>}
                              {h.createdAt && <span className="ml-auto text-neutral-400">{formatDateTime(h.createdAt)}</span>}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    <div className="flex items-center justify-between pt-2 border-t border-neutral-100">
                      <span className="text-sm text-neutral-500">Placed {formatDate(order.createdAt)}</span>
                      <div className="flex gap-3"><Link to={`/track?order=${encodeURIComponent(order.orderId)}`} className="text-sm font-medium text-neutral-700 hover:text-neutral-900">Track Order</Link>{up(order.paymentStatus) !== 'PAID' && up(order.paymentStatus) !== 'CANCELLED' && up(order.orderStatus) !== 'CANCELLED' && <Link to={`/checkout?order=${encodeURIComponent(order.id)}`}><Button size="sm">Pay now</Button></Link>}</div>
                    </div>
                    {up(order.paymentStatus) === 'PAID' && <InvoiceButton order={order} />}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

function InfoLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="p-3 bg-neutral-50 rounded-lg">
      <p className="text-xs text-neutral-500 mb-0.5">{label}</p>
      <p className="text-sm font-medium text-neutral-900 break-words">{value}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Payments — every order that has a payment attempt, with its real status.
// ---------------------------------------------------------------------------
function PaymentsTab({ orders }: any) {
  const withPayments = orders.filter((o: any) => o.paymentStatus != null && up(o.paymentStatus) !== '');
  return (
    <div className="space-y-6">
      <h2 className="text-xl font-bold text-neutral-900">Payment History</h2>
      {withPayments.length === 0 ? (
        <Card className="p-8"><EmptyState title="No payments yet" description="Your payment history will appear here." /></Card>
      ) : (
        <Card className="overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-neutral-50 border-b border-neutral-200">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-neutral-600">Order</th>
                  <th className="text-left px-4 py-3 font-medium text-neutral-600">Amount</th>
                  <th className="text-left px-4 py-3 font-medium text-neutral-600">Method</th>
                  <th className="text-left px-4 py-3 font-medium text-neutral-600">Status</th>
                  <th className="text-left px-4 py-3 font-medium text-neutral-600">Receipt</th>
                  <th className="text-left px-4 py-3 font-medium text-neutral-600">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {withPayments.map((order: any) => (
                  <tr key={order.id} className="hover:bg-neutral-50">
                    <td className="px-4 py-3 font-medium">{order.orderId}</td>
                    <td className="px-4 py-3">{formatCurrency(num(order.total))}</td>
                    <td className="px-4 py-3 text-neutral-500">M-Pesa</td>
                    <td className="px-4 py-3"><Badge variant={getStatusBadge(up(order.paymentStatus)).variant}>{getStatusBadge(up(order.paymentStatus)).label}</Badge></td>
                    <td className="px-4 py-3 text-neutral-500">{up(order.paymentStatus) === 'PAID' ? (order.receiptNumber || '—') : '—'}</td>
                    <td className="px-4 py-3 text-neutral-500">{formatDate(order.updatedAt || order.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
    </div>
  );
}

function SupportTab() {
  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-bold text-neutral-900">Support Tickets</h2>
        <Link to="/support"><Button size="sm">New Ticket</Button></Link>
      </div>
      <Card className="p-6">
        <p className="text-sm text-neutral-500 mb-4">Your support tickets and conversations.</p>
        <Link to="/support" className="text-sm font-medium text-neutral-700 hover:text-neutral-900">View all tickets</Link>
      </Card>
    </div>
  );
}

function NotificationsTab() {
  const { state, dispatch } = useApp();
  return (
    <div className="space-y-6">
      <h2 className="text-xl font-bold text-neutral-900">Notifications</h2>
      {state.notifications.length === 0 ? (
        <Card className="p-8"><EmptyState title="No notifications" description="You're all caught up." /></Card>
      ) : (
        <div className="space-y-2">
          {state.notifications.map(n => (
            <Card key={n.id} className={`p-4 ${!n.read ? 'border-neutral-900 bg-neutral-50' : ''}`}>
              <div className="flex items-start justify-between">
                <div>
                  <p className="font-medium text-sm text-neutral-900">{n.title}</p>
                  <p className="text-xs text-neutral-500 mt-0.5">{n.message}</p>
                  <p className="text-xs text-neutral-400 mt-1">{formatDateTime(n.createdAt)}</p>
                </div>
                {!n.read && <button onClick={() => { dispatch({ type: 'MARK_NOTIFICATION_READ', payload: n.id }); void markNotificationReadOnServer(n.id); }} className="text-xs text-neutral-500 hover:text-neutral-900">Mark read</button>}
              </div>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function ProfileTab() {
  const { state, dispatch } = useApp();
  const [phoneDraft, setPhoneDraft] = useState('');
  const [phoneSaving, setPhoneSaving] = useState(false);
  const [phoneError, setPhoneError] = useState('');

  const saveProfilePhone = async (event: React.FormEvent) => {
    event.preventDefault();
    const raw = phoneDraft.replace(/[\s()\-]/g, '');
    if (!/^(\+254|0)[17]\d{8}$/.test(raw)) {
      setPhoneError('Enter a valid Kenyan phone number, e.g. 0712 345 678.');
      return;
    }
    setPhoneError('');
    setPhoneSaving(true);
    try {
      await apiFetch('/api/auth/sync-profile', { method: 'POST', body: JSON.stringify({ phoneNumber: raw }) });
      if (state.user) dispatch({ type: 'SET_USER', payload: { ...state.user, phone: raw.startsWith('+') ? raw : `+254${raw.slice(1)}` } });
      setPhoneDraft('');
    } catch (error) {
      setPhoneError(error instanceof Error ? error.message : 'Could not save your phone number.');
    } finally {
      setPhoneSaving(false);
    }
  };

  return (
    <div className="space-y-6">
      <h2 className="text-xl font-bold text-neutral-900">Profile</h2>
      {!state.user?.phone && (
        <form onSubmit={saveProfilePhone} className="rounded-lg border border-yellow-200 bg-yellow-50 px-4 py-3 space-y-2">
          <p className="text-sm text-yellow-800 font-medium">Add your phone number so we can send the M-Pesa prompt</p>
          <div className="flex flex-col sm:flex-row gap-2">
            <input
              value={phoneDraft}
              onChange={event => setPhoneDraft(event.target.value)}
              placeholder="+254 7XX XXX XXX"
              className="flex-1 rounded-lg border border-yellow-300 bg-white px-3 py-2 text-sm text-neutral-900 focus:outline-none focus:ring-2 focus:ring-yellow-400"
            />
            <Button type="submit" size="sm" loading={phoneSaving}>Save phone</Button>
          </div>
          {phoneError && <p className="text-sm text-red-700">{phoneError}</p>}
        </form>
      )}
      <Card className="p-6">
        <div className="flex items-center gap-4 mb-6">
          <div className="w-16 h-16 bg-neutral-900 rounded-full flex items-center justify-center">
            <span className="text-white font-bold text-xl">{(state.user?.name || '?').charAt(0)}</span>
          </div>
          <div>
            <p className="font-semibold text-neutral-900">{state.user?.name}</p>
            <p className="text-sm text-neutral-500">{state.user?.email}</p>
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div className="p-4 bg-neutral-50 rounded-lg">
            <p className="text-xs text-neutral-500 mb-1">Phone</p>
            <p className="text-sm font-medium text-neutral-900">{state.user?.phone || '—'}</p>
          </div>
          <div className="p-4 bg-neutral-50 rounded-lg">
            <p className="text-xs text-neutral-500 mb-1">Member Since</p>
            <p className="text-sm font-medium text-neutral-900">{state.user?.createdAt ? formatDate(state.user.createdAt) : '—'}</p>
          </div>
          <div className="p-4 bg-neutral-50 rounded-lg">
            <p className="text-xs text-neutral-500 mb-1">Account Type</p>
            <p className="text-sm font-medium text-neutral-900 capitalize">{state.user?.role}</p>
          </div>
        </div>
      </Card>
    </div>
  );
}

function StatCard({ label, value }: { label: string; value: string | number }) {
  return (
    <Card className="p-4">
      <p className="text-xs text-neutral-500 mb-1">{label}</p>
      <p className="text-xl font-bold text-neutral-900">{value}</p>
    </Card>
  );
}

// Shared "Download invoice" outline button for PAID orders. Errors are shown
// inline under the button — no alert/confirm/popups. Reused by the My Orders
// accordion and the Overview order list.
function InvoiceButton({ order }: { order: any }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const invoiceNumber = String(order.invoiceNumber || '').trim()
    || String(order.orderId || '').replace(/^HS-/, 'INV-');
  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      await apiDownload(
        `/api/invoices/download?orderDocumentId=${encodeURIComponent(String(order.id))}`,
        `HerStep-Invoice-${invoiceNumber}.pdf`,
      );
    } catch (e: any) {
      setError(e?.message || 'We could not download your invoice.');
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="pt-3">
      <Button variant="outline" size="sm" onClick={download} disabled={busy}>
        <FileText className="w-4 h-4 mr-2" />
        {busy ? 'Preparing…' : `Download invoice ${invoiceNumber}`}
      </Button>
      {error && <p role="alert" className="text-xs text-red-600 mt-2">{error}</p>}
    </div>
  );
}
