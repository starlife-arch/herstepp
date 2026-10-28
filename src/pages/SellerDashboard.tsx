import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, BadgeCheck, Clock3, CreditCard, MessageCircle, PackageCheck, PackagePlus, RefreshCw, Store } from 'lucide-react';
import { Badge, Button, Card } from '../components/ui';
import { apiFetch } from '../lib/api';
import { usePageMeta } from '../hooks/usePageMeta';

type Seller = {
  displayName?: string;
  businessName?: string;
  status?: string;
  planCode?: string;
  billingStatus?: string;
  subscriptionExpiresAt?: string | null;
  badgeSubscriptionStatus?: string;
  badgeSubscriptionExpiresAt?: string | null;
  verificationBadge?: boolean;
  createdAt?: string | null;
} | null;

type Application = {
  displayName?: string;
  status?: string;
  adminReason?: string;
} | null;

type SellerPayment = {
  paymentId: string;
  status: string;
  amount: number;
  currency: string;
  planCode: string;
  failureReason?: string | null;
  transactionReference?: string | null;
} | null;

const plans = [
  { code: 'STARTER', name: 'Starter', price: 150, limit: '20 active products', description: 'For a small shop getting started.' },
  { code: 'STANDARD', name: 'Standard', price: 350, limit: 'Up to 100 active products', description: 'For shops building a steady catalogue.' },
  { code: 'GROWTH', name: 'Growth', price: 800, limit: 'Up to 1,000 active products', description: 'For growing product ranges.' },
  { code: 'UNLIMITED', name: 'Unlimited', price: 1500, limit: 'Unlimited active products', description: 'For large catalogues.' },
];

const formatMoney = (amount: number) => new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES', maximumFractionDigits: 0 }).format(amount);
const formatDate = (value?: string | null) => {
  if (!value) return 'Not set';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Not set' : date.toLocaleDateString('en-KE', { year: 'numeric', month: 'short', day: 'numeric' });
};
const formatDateTime = (value?: string | null) => {
  if (!value) return 'Not recorded';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Not recorded' : date.toLocaleString('en-KE', { timeZone: 'Africa/Nairobi', year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
};
const terminalStatuses = new Set(['PAID', 'FAILED', 'CANCELLED', 'TIMEOUT']);

export default function SellerDashboard() {
  usePageMeta('Seller Dashboard | HerStep Collection', 'Manage your HerStep marketplace seller account.');
  const [seller, setSeller] = useState<Seller>(null);
  const [application, setApplication] = useState<Application>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [phone, setPhone] = useState('');
  const [selectedPlan, setSelectedPlan] = useState<string | null>(null);
  const [paymentError, setPaymentError] = useState('');
  const [paymentNotice, setPaymentNotice] = useState('');
  const [paymentBusy, setPaymentBusy] = useState(false);
  const [payment, setPayment] = useState<SellerPayment>(null);
  const [rewardInfo, setRewardInfo] = useState<any>(null);
  const [rewardBusyPlan, setRewardBusyPlan] = useState<string | null>(null);
  const [idempotencyKeys, setIdempotencyKeys] = useState<Record<string, string>>({});
  const [promotionProducts, setPromotionProducts] = useState<{ id: string; name: string; promotedUntil: string | null }[]>([]);
  const [promotionProductId, setPromotionProductId] = useState('');
  const [promotionPhone, setPromotionPhone] = useState('');
  const [promotionPayment, setPromotionPayment] = useState<any>(null);
  const [promotionBusy, setPromotionBusy] = useState(false);
  const [promotionMessage, setPromotionMessage] = useState('');
  const [promotionError, setPromotionError] = useState('');
  const [payoutData, setPayoutData] = useState<any>(null);
  const [payoutAmount, setPayoutAmount] = useState('');
  const [payoutPhone, setPayoutPhone] = useState('');
  const [payoutBusy, setPayoutBusy] = useState(false);
  const [payoutNotice, setPayoutNotice] = useState('');
  const [payoutError, setPayoutError] = useState('');

  async function refreshDashboard() {
    const result: any = await apiFetch('/api/sellers/dashboard');
    setSeller(result.seller || null);
    setPayoutPhone(current => current || result.seller?.defaultPayoutPhone || '');
    setApplication(result.application || null);
  }

  useEffect(() => {
    let active = true;
    apiFetch('/api/sellers/dashboard')
      .then((result: any) => {
        if (!active) return;
        setSeller(result.seller || null);
        setPayoutPhone(current => current || result.seller?.defaultPayoutPhone || '');
        setApplication(result.application || null);
      })
      .catch((err: any) => {
        if (active) setError(err?.message || 'Could not load your seller dashboard.');
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (seller?.status !== 'ACTIVE') return;
    apiFetch('/api/rewards/account').then(setRewardInfo).catch(() => setRewardInfo(null));
    let active = true;
    apiFetch('/api/sellers/payouts').then((result: any) => {
      if (active) setPayoutData(result);
    }).catch((err: any) => {
      if (active) setPayoutError(err?.message || 'Could not load seller earnings.');
    });
    return () => { active = false; };
  }, [seller?.status]);

  async function requestPayout() {
    const amount = Number(payoutAmount);
    if (!Number.isSafeInteger(amount) || amount < 10) { setPayoutError('The minimum payout is KSh 10.'); return; }
    if (!payoutPhone.trim()) { setPayoutError('Enter the Kenyan M-Pesa number to receive the payout.'); return; }
    setPayoutBusy(true); setPayoutError(''); setPayoutNotice('');
    try {
      const result: any = await apiFetch('/api/sellers/payouts', {
        method: 'POST',
        body: JSON.stringify({ amount, payoutPhone: payoutPhone.trim(), idempotencyKey: `payout-${crypto.randomUUID()}` }),
      });
      setPayoutNotice(result.message || 'Your payout request was received and is being processed.');
      setPayoutAmount('');
      const refreshed: any = await apiFetch('/api/sellers/payouts');
      setPayoutData(refreshed);
    } catch (err: any) { setPayoutError(err?.message || 'Could not submit payout request.'); }
    finally { setPayoutBusy(false); }
  }

  async function startSubscription(planCode: string) {
    if (!phone.trim()) {
      setPaymentError('Enter the Kenyan M-Pesa number that should receive the payment prompt.');
      return;
    }
    setPaymentBusy(true);
    setPaymentError('');
    setPaymentNotice('');
    const key = idempotencyKeys[planCode] || `seller-${crypto.randomUUID()}`;
    setIdempotencyKeys(current => ({ ...current, [planCode]: key }));
    try {
      const result: any = await apiFetch('/api/sellers/subscription', {
        method: 'POST',
        body: JSON.stringify({ planCode, phone: phone.trim(), idempotencyKey: key }),
      });
      setPayment({ ...result.payment, planCode });
      setSelectedPlan(null);
      setPaymentNotice('M-Pesa prompt sent. Approve it on your phone; we will check the payment and update your plan.');
    } catch (err: any) {
      setPaymentError(err?.message || 'Could not start the subscription payment. Use the same plan button to safely retry or contact support.');
    } finally {
      setPaymentBusy(false);
    }
  }

  async function redeemPlanWithRewards(planCode: string) {
    setRewardBusyPlan(planCode); setPaymentError(''); setPaymentNotice('');
    try {
      const result: any = await apiFetch('/api/sellers/subscription', { method: 'POST', body: JSON.stringify({ action: 'REDEEM_REWARDS', planCode, idempotencyKey: 'seller-reward-' + crypto.randomUUID() }) });
      const current = result.payment || {};
      setPayment({ paymentId: current.paymentId, status: current.status || 'PAID', amount: current.amount, currency: 'KES', planCode: current.planCode || planCode });
      setPaymentNotice(result.message || 'Reward redemption confirmed and subscription activated.');
      const refreshed: any = await apiFetch('/api/rewards/account'); setRewardInfo(refreshed);
      await refreshDashboard();
    } catch (err: any) { setPaymentError(err?.message || 'Could not redeem points for this plan.'); }
    finally { setRewardBusyPlan(null); }
  }

  async function checkPaymentStatus() {
    if (!payment?.paymentId) return;
    setPaymentBusy(true);
    setPaymentError('');
    setPaymentNotice('');
    try {
      const result: any = await apiFetch(`/api/sellers/subscription?paymentId=${encodeURIComponent(payment.paymentId)}`);
      const current = result.payment;
      setPayment(current ? { ...current, planCode: current.planCode || payment.planCode } : payment);
      if (current?.status === 'PAID') {
        setPaymentNotice('Payment confirmed. Your subscription has been activated.');
        setIdempotencyKeys(keys => {
          const next = { ...keys };
          delete next[payment.planCode];
          return next;
        });
        await refreshDashboard();
      } else if (current && terminalStatuses.has(current.status)) {
        setPaymentNotice(current.failureReason || `Payment status: ${current.status}. You can start a new payment attempt.`);
        setIdempotencyKeys(keys => {
          const next = { ...keys };
          delete next[payment.planCode];
          return next;
        });
      } else {
        setPaymentNotice('The payment is still pending. Approve the M-Pesa prompt if it is still on your phone, then check again.');
      }
    } catch (err: any) {
      setPaymentError(err?.message || 'Could not check payment status. Please try again.');
    } finally {
      setPaymentBusy(false);
    }
  }

  useEffect(() => {
    if (!payment?.paymentId || payment.status !== 'PENDING') return;
    let active = true;
    let attempts = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (!active || attempts >= 24) return;
      attempts++;
      try {
        const result: any = await apiFetch(`/api/sellers/subscription?paymentId=${encodeURIComponent(payment.paymentId)}`);
        const current = result.payment;
        if (active && current) {
          setPayment({ ...current, planCode: current.planCode || payment.planCode });
          if (current.status === 'PAID') {
            setPaymentNotice('Payment confirmed automatically. Your seller subscription is active.');
            setIdempotencyKeys(keys => { const next = { ...keys }; delete next[payment.planCode]; return next; });
            await refreshDashboard();
            return;
          }
          if (terminalStatuses.has(current.status)) {
            setPaymentNotice(current.failureReason || `Payment status: ${current.status}. You can start another payment attempt.`);
            setIdempotencyKeys(keys => { const next = { ...keys }; delete next[payment.planCode]; return next; });
            return;
          }
        }
      } catch (err: any) {
        if (active) setPaymentError(err?.message || 'Payment verification is still retrying.');
      }
      if (active && attempts < 24) timer = setTimeout(poll, 5000);
      else if (active) setPaymentNotice('Payment is still pending. We will keep the status available here; you can retry the check shortly.');
    };
    timer = setTimeout(poll, 3000);
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [payment?.paymentId, payment?.status]);

  useEffect(() => {
    const expires = seller?.subscriptionExpiresAt ? new Date(seller.subscriptionExpiresAt).getTime() : 0;
    const active = seller?.status === 'ACTIVE' && seller?.billingStatus === 'ACTIVE' && Number.isFinite(expires) && expires > Date.now();
    if (!active) return;
    apiFetch('/api/sellers/promotions').then((result: any) => {
      const items = Array.isArray(result.products) ? result.products : [];
      setPromotionProducts(items);
      setPromotionProductId(current => current || items.find((p: any) => !p.promotedUntil)?.id || items[0]?.id || '');
    }).catch(() => {});
  }, [seller?.status, seller?.billingStatus, seller?.subscriptionExpiresAt]);

  async function startPromotion() {
    if (!promotionProductId) { setPromotionError('Choose an active product first.'); return; }
    if (!promotionPhone.trim()) { setPromotionError('Enter the M-Pesa number that should receive the KSh 100 prompt.'); return; }
    setPromotionBusy(true); setPromotionError(''); setPromotionMessage('');
    try {
      const key = `promote-${crypto.randomUUID()}`;
      let result: any;
      try {
        result = await apiFetch('/api/sellers/promotions', { method: 'POST', body: JSON.stringify({ productId: promotionProductId, phone: promotionPhone.trim(), idempotencyKey: key }) });
      } catch (firstErr: any) {
        // If a previous attempt was blocked by a spent/stuck payment record,
        // retry once with a brand-new idempotency key so the seller always
        // gets a fresh STK push instead of an error.
        if (!/already|ended|prepared/i.test(firstErr?.message || '')) throw firstErr;
        const retryKey = `promote-${crypto.randomUUID()}`;
        result = await apiFetch('/api/sellers/promotions', { method: 'POST', body: JSON.stringify({ productId: promotionProductId, phone: promotionPhone.trim(), idempotencyKey: retryKey }) });
      }
      setPromotionPayment(result.payment);
      setPromotionMessage('Approve the KSh 100 M-Pesa prompt on ' + promotionPhone.trim() + '. Your listing will be promoted only after payment is verified.');
    } catch (err: any) { setPromotionError(err?.message || 'Could not start promotion payment. Please try again.'); }
    finally { setPromotionBusy(false); }
  }

  async function checkPromotionPayment() {
    if (!promotionPayment?.paymentId) return;
    setPromotionBusy(true); setPromotionError('');
    try {
      const result: any = await apiFetch(`/api/sellers/promotions?paymentId=${encodeURIComponent(promotionPayment.paymentId)}`);
      setPromotionPayment(result.payment);
      if (result.payment?.status === 'PAID') {
        setPromotionMessage('Payment verified. This listing is promoted for 7 days.');
        const refreshed: any = await apiFetch('/api/sellers/promotions');
        setPromotionProducts(Array.isArray(refreshed.products) ? refreshed.products : []);
      } else if (['FAILED', 'CANCELLED', 'TIMEOUT'].includes(result.payment?.status)) {
        setPromotionMessage(result.payment.failureReason || `Payment status: ${result.payment.status}. You can try again.`);
      } else setPromotionMessage('Payment is still pending. Approve the prompt, then check again.');
    } catch (err: any) { setPromotionError(err?.message || 'Could not check promotion payment.'); }
    finally { setPromotionBusy(false); }
  }

  if (loading) return <div className="max-w-6xl mx-auto px-4 py-12"><Card className="p-8 text-center text-sm text-neutral-500">Loading seller dashboard…</Card></div>;

  const approved = seller?.status === 'ACTIVE';
  const suspended = seller?.status === 'SUSPENDED' || application?.status === 'SUSPENDED';
  const expiryMs = seller?.subscriptionExpiresAt ? new Date(seller.subscriptionExpiresAt).getTime() : 0;
  const subscriptionActive = seller?.billingStatus === 'ACTIVE' && Number.isFinite(expiryMs) && expiryMs > Date.now();

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-10 animate-fadeIn">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-8">
        <div>
          <p className="text-xs font-semibold tracking-wide text-neutral-500 mb-2">HERSTEP MARKETPLACE</p>
          <h1 className="text-3xl font-bold text-neutral-900">Seller dashboard</h1>
          <p className="text-neutral-600 mt-2">Your seller account, subscription options, and next steps in one place.</p>
        </div>
        <div className="flex flex-wrap gap-2"><Link to="/messages"><Button variant="outline"><MessageCircle className="w-4 h-4 mr-2" /> Messages</Button></Link><Link to="/seller/orders"><Button variant="outline"><PackageCheck className="w-4 h-4 mr-2" /> Marketplace orders</Button></Link><Link to="/seller/products"><Button><PackagePlus className="w-4 h-4 mr-2" /> My products</Button></Link><Link to="/seller/promotions"><Button variant="outline"><CreditCard className="w-4 h-4 mr-2" /> Promotion wallet</Button></Link><Link to="/seller/apply"><Button variant="outline"><Store className="w-4 h-4 mr-2" /> Application details</Button></Link><Link to="/seller/profile"><Button variant="outline"><Store className="w-4 h-4 mr-2" /> Business profile</Button></Link></div>
      </div>

      {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 mb-6">{error}</div>}

      {approved && <Card className="p-5 sm:p-6 mb-8">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><h2 className="text-xl font-semibold text-neutral-900">Marketplace earnings & payouts</h2><p className="text-sm text-neutral-600 mt-1">Only delivered orders can become available. Orders with refund activity are temporarily held for review.</p></div>
          <Button variant="outline" size="sm" onClick={() => apiFetch('/api/sellers/payouts').then(setPayoutData).catch((err: any) => setPayoutError(err?.message || 'Could not refresh earnings.'))}><RefreshCw className="w-4 h-4 mr-2" /> Refresh</Button>
        </div>
        {payoutError && <p role="alert" className="mt-3 text-sm text-red-700">{payoutError}</p>}
        {payoutNotice && <p role="status" className="mt-3 text-sm text-emerald-700">{payoutNotice}</p>}
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 mt-4">
          <div className="rounded-lg bg-neutral-50 border p-4"><p className="text-xs text-neutral-500">Available balance</p><p className="text-2xl font-bold mt-1">{formatMoney(Number(payoutData?.availableBalance) || 0)}</p></div>
          <div className="rounded-lg bg-neutral-50 border p-4"><p className="text-xs text-neutral-500">Held for review</p><p className="text-2xl font-bold mt-1">{formatMoney(Number(payoutData?.heldBalance) || 0)}</p><p className="text-xs text-neutral-500 mt-1">Temporarily unavailable while refund cases are reviewed.</p></div>
          <div className="rounded-lg bg-neutral-50 border p-4"><p className="text-xs text-neutral-500">Pending earnings</p><p className="text-2xl font-bold mt-1">{formatMoney(Number(payoutData?.pendingBalance) || 0)}</p></div>
          <div className="rounded-lg bg-neutral-50 border p-4"><p className="text-xs text-neutral-500">Total withdrawn</p><p className="text-2xl font-bold mt-1">{formatMoney(Number(payoutData?.totalWithdrawn) || 0)}</p><p className="text-xs text-neutral-500 mt-1">Confirmed paid payouts only.</p></div>
          <div className="rounded-lg bg-neutral-50 border p-4"><p className="text-xs text-neutral-500">Payouts completed</p><p className="text-2xl font-bold mt-1">{Number(payoutData?.paidPayoutCount) || 0}</p></div>
          <div className="rounded-lg bg-neutral-50 border p-4"><p className="text-xs text-neutral-500">Payout requests</p><p className="text-2xl font-bold mt-1">{Number(payoutData?.totalPayoutRequests) || (Array.isArray(payoutData?.payouts) ? payoutData.payouts.length : 0)}</p></div>
        </div>
        <div className="grid gap-3 sm:grid-cols-[1fr_1fr_auto] mt-4 items-end">
          <div><label className="block text-sm font-medium mb-1" htmlFor="seller-payout-amount">Amount (KSh)</label><input id="seller-payout-amount" type="number" min="10" step="1" max={Number(payoutData?.availableBalance) || undefined} value={payoutAmount} onChange={e => setPayoutAmount(e.target.value)} className="w-full rounded-lg border border-neutral-300 px-3 py-2" placeholder="e.g. 1500" /><p className="mt-1 text-xs text-red-600">{payoutAmount && Number(payoutAmount) < 10 ? 'The minimum payout is KSh 10.' : ''}</p></div>
          <div><label className="block text-sm font-medium mb-1" htmlFor="seller-payout-phone">M-Pesa payout number</label><p className="text-xs text-neutral-500 mb-2">Your saved default is prefilled. You can enter a different number for this payout only.</p><input id="seller-payout-phone" value={payoutPhone} onChange={e => setPayoutPhone(e.target.value)} className="w-full rounded-lg border border-neutral-300 px-3 py-2" placeholder="07… or +254…" autoComplete="tel" /></div>
          <Button onClick={requestPayout} disabled={payoutBusy || !payoutData || Number(payoutAmount) < 10}><CreditCard className="w-4 h-4 mr-2" />{payoutBusy ? 'Submitting…' : 'Request payout'}</Button>
        </div>
        <p className="text-xs text-neutral-600 mt-2">Minimum payout: KSh 10. Only available earnings can be withdrawn.</p>
        <div className="mt-5 space-y-2">
          {[...(payoutData?.payouts || [])].sort((a: any, b: any) => (Date.parse(b.requestedAt || b.updatedAt || '') || 0) - (Date.parse(a.requestedAt || a.updatedAt || '') || 0)).slice(0, 10).map((payout: any) => { const status = String(payout.status || '').toUpperCase(); const statusText = status === 'REQUESTED' || status === 'PENDING' ? 'Waiting for funds' : status === 'PROCESSING' || status === 'DISPATCHING' ? 'Processing' : status === 'PAID' ? 'Paid' : status === 'FAILED' ? 'Failed - balance returned' : status === 'PROVIDER_UNKNOWN' ? 'Being checked - balance reserved' : status.replace(/_/g, ' '); return <div key={payout.id} className="border-t pt-3 text-sm"><div className="flex flex-wrap items-center justify-between gap-2"><span className="font-medium">{formatMoney(Number(payout.amount) || 0)} · {payout.payoutPhoneMasked || 'M-Pesa'}</span><span className="text-neutral-600">{statusText}{payout.providerReference ? ` · ${payout.providerReference}` : ''}</span></div><div className="mt-2 grid gap-1 text-xs text-neutral-500 sm:grid-cols-2"><span>Requested: {formatDateTime(payout.requestedAt)}</span><span>Processing started: {formatDateTime(payout.processingStartedAt)}</span><span>Last checked: {formatDateTime(payout.lastCheckedAt)}</span><span>Paid: {formatDateTime(payout.paidAt)}</span></div></div>; })}
          {payoutData && !(payoutData.payouts || []).length && <p className="text-sm text-neutral-500">No payout requests yet.</p>}
        </div>
        <div className="mt-6 border-t pt-5">
          <h3 className="text-lg font-semibold text-neutral-900">Refund and reversal cases</h3>
          <p className="text-sm text-neutral-600 mt-1">Cases linked to your marketplace orders. Refund decisions and account balance adjustments are handled by HerStep Marketplace Operations.</p>
          {(payoutData?.sellerRefundCases || []).length === 0 ? <p className="text-sm text-neutral-500 mt-3">No refund or reversal cases found for your orders.</p> : <div className="mt-3 space-y-3">{payoutData.sellerRefundCases.map((item: any) => <div key={item.id} className="rounded-lg border p-3">
            <div className="flex flex-wrap items-start justify-between gap-2"><div><p className="font-medium">Order {item.orderId}</p><p className="text-xs text-neutral-500 mt-1">Case: {item.id} · {formatDateTime(item.createdAt)}</p></div><span className="rounded-full bg-neutral-100 px-2 py-1 text-xs font-semibold">{String(item.status || 'REQUESTED').replace(/_/g, ' ')}</span></div>
            <p className="text-sm mt-2">Amount: {formatMoney(Number(item.amount) || 0)}</p>
            {item.reason && <p className="text-sm text-neutral-600 mt-1">Reason: {item.reason}</p>}
            {item.resolution && <p className="text-sm text-neutral-600 mt-1">Admin update: {item.resolution}</p>}
          </div>)}</div>}
        </div>
      </Card>}

      <Card className="p-5 sm:p-6 mb-8">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="rounded-xl bg-neutral-100 p-3"><Store className="w-6 h-6 text-neutral-700" /></div>
            <div>
              <h2 className="text-xl font-semibold text-neutral-900">{seller?.displayName || application?.displayName || 'Your seller shop'}</h2>
              <p className="text-sm text-neutral-600 mt-1">{seller?.businessName || 'HerStep marketplace seller account'}</p>
              <p className="text-xs text-neutral-500 mt-2">Seller status: {suspended ? 'SUSPENDED' : approved && !subscriptionActive ? 'APPROVED — PLAN REQUIRED' : subscriptionActive ? 'ACTIVE SUBSCRIPTION' : application?.status || 'APPLICATION NOT STARTED'}</p>
            </div>
          </div>
          {approved ? <Badge variant="success"><BadgeCheck className="inline w-3.5 h-3.5 mr-1" /> Approved</Badge> : suspended ? <Badge variant="danger">Suspended</Badge> : <Badge variant="warning">{application?.status === 'PENDING' ? 'Under review' : application?.status === 'REJECTED' ? 'Changes required' : 'Application needed'}</Badge>}
        </div>
        {approved && <p className="text-sm text-neutral-600 mt-4">Your seller account is approved. Complete an active subscription to qualify for publishing. The verified badge is shown only after identity verification; paying the add-on alone does not verify identity.</p>}
        {subscriptionActive && <div className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-900"><strong>Subscription active.</strong> Plan: {seller?.planCode || 'STARTER'}. Expires {formatDate(seller?.subscriptionExpiresAt)}.</div>}
        {approved && !subscriptionActive && <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">Your subscription is not currently active. Choose a plan below to start or renew your monthly subscription with M-Pesa.</div>}
        {suspended && <p className="text-sm text-neutral-600 mt-3">Seller access is currently suspended. Contact support if you need help resolving this.</p>}
        {!approved && !suspended && <div className="mt-4"><p className="text-sm text-neutral-600 mb-3">{application?.status === 'PENDING' ? 'Your application is awaiting admin review. You can check back here for updates.' : application?.status === 'REJECTED' ? (application.adminReason || 'Please review your application details and resubmit.') : 'Submit a seller application to start the review process.'}</p><Link to="/seller/apply"><Button>{application?.status === 'REJECTED' ? 'Update application' : application?.status === 'PENDING' ? 'View application' : 'Apply to sell'} <ArrowRight className="w-4 h-4 ml-2" /></Button></Link></div>}
      </Card>

      <div className="mb-5">
        <h2 className="text-2xl font-bold text-neutral-900">Seller subscription plans</h2>
        <p className="text-sm text-neutral-600 mt-2">Monthly pricing includes the KSh 50 verified-badge subscription add-on. Identity verification is a separate approval.</p>
      </div>

      {paymentNotice && <p role="status" className="mb-3 text-sm text-neutral-700">{paymentNotice}</p>}
      {paymentError && !selectedPlan && <p role="alert" className="mb-3 text-sm text-red-700">{paymentError}</p>}
      {payment && approved && <Card className="p-4 mb-5">
        <p className="text-sm font-semibold text-neutral-900">Latest plan payment: {payment.status}</p>
        <p className="text-sm text-neutral-600 mt-1">{formatMoney(Number(payment.amount) || 0)} · {payment.planCode} · Reference {payment.paymentId.slice(0, 12)}…</p>
        {payment.failureReason && <p className="text-sm text-red-700 mt-2">{payment.failureReason}</p>}
        {payment.status === 'PENDING' && <Button className="mt-3" variant="outline" onClick={checkPaymentStatus} disabled={paymentBusy}><RefreshCw className="w-4 h-4 mr-2" />{paymentBusy ? 'Checking…' : 'Check payment status'}</Button>}
      </Card>}
      {selectedPlan && approved && !suspended && <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" role="dialog" aria-modal="true" aria-labelledby="seller-plan-payment-title">
        <Card className="w-full max-w-md p-6">
          <h3 id="seller-plan-payment-title" className="text-xl font-semibold">Pay for {plans.find(plan => plan.code === selectedPlan)?.name || 'seller plan'}</h3>
          <p className="text-sm text-neutral-600 mt-2">Total due now: {formatMoney((plans.find(plan => plan.code === selectedPlan)?.price || 0) + 50)} for one month, including the KSh 50 badge subscription add-on. Identity verification remains separate.</p>
          <label htmlFor="seller-mpesa-phone" className="block text-sm font-medium text-neutral-800 mt-4 mb-2">M-Pesa phone number</label>
          <input id="seller-mpesa-phone" type="tel" autoComplete="tel" value={phone} onChange={event => setPhone(event.target.value)} placeholder="07XXXXXXXX or +2547XXXXXXXX" className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-neutral-500" />
          {paymentError && <p role="alert" className="text-sm text-red-700 mt-3">{paymentError}</p>}
          <div className="flex gap-3 mt-5">
            <Button variant="outline" className="flex-1" disabled={paymentBusy} onClick={() => { setSelectedPlan(null); setPaymentError(''); }}>Cancel</Button>
            <Button className="flex-1" disabled={paymentBusy || !phone.trim()} onClick={() => { if (selectedPlan) void startSubscription(selectedPlan); }}><CreditCard className="w-4 h-4 mr-2" />{paymentBusy ? 'Starting…' : 'Pay with M-Pesa'}</Button>
          </div>
        </Card>
      </div>}

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {plans.map(plan => (
          <Card key={plan.code} className="p-5 flex flex-col">
            <h3 className="text-lg font-semibold text-neutral-900">{plan.name}</h3>
            <p className="text-sm text-neutral-500 mt-1 min-h-10">{plan.description}</p>
            <div className="mt-4"><span className="text-2xl font-bold text-neutral-900">{formatMoney(plan.price + 50)}</span><span className="text-xs text-neutral-500"> / month</span></div>
            <p className="text-xs text-neutral-500 mt-1">{formatMoney(plan.price)} plan + {formatMoney(50)} badge add-on</p>
            <div className="border-t border-neutral-100 my-4" />
            <p className="text-sm font-medium text-neutral-800">{plan.limit}</p>
            <p className="text-sm text-neutral-600 mt-3">Verified-badge subscription: {formatMoney(50)}/month</p>
            <Button variant="outline" className="mt-5 w-full" disabled={!approved || suspended || paymentBusy} onClick={() => { setSelectedPlan(plan.code); setPaymentError(''); }}>
              <CreditCard className="w-4 h-4 mr-2" />{paymentBusy ? 'Please wait…' : subscriptionActive ? (seller?.planCode === plan.code ? 'Renew this plan' : 'Switch to ' + plan.name) : approved ? 'Pay with M-Pesa' : 'Approval required'}
            </Button>
            <div className="mt-3 border-t pt-3">
              <p className="text-xs text-neutral-600">Seller reward balance: {Number(rewardInfo?.pointsBalance || 0).toLocaleString()} ledger-verified points</p>
              <p className="text-xs text-neutral-600">Requires {Math.ceil((plan.price + 50) / (Number(rewardInfo?.pointValueKes) || 0.1)).toLocaleString()} points for one month, including the KSh 50 badge subscription fee.</p>
              {rewardInfo?.balanceMismatch && <p role="alert" className="text-xs text-amber-700 mt-2">Your saved reward balance ({Number(rewardInfo.storedPointsBalance || 0).toLocaleString()}) does not match your reward ledger ({Number(rewardInfo.pointsBalance || 0).toLocaleString()}). Redemption is blocked until the ledger is reconciled.</p>}
              {!(rewardInfo?.redemptionEnabled && rewardInfo?.redemptionTargets?.includes('SELLER_PLAN')) && <p className="text-xs text-neutral-500 mt-2">Reward-point plan payments are currently disabled by the rewards settings.</p>}
              <Button className="mt-2 w-full" disabled={!approved || suspended || !!rewardBusyPlan || !rewardInfo?.redemptionEnabled || !rewardInfo?.redemptionTargets?.includes('SELLER_PLAN') || !!rewardInfo?.balanceMismatch || Number(rewardInfo?.pointsBalance || 0) < Math.ceil((plan.price + 50) / (Number(rewardInfo?.pointValueKes) || 0.1))} onClick={() => void redeemPlanWithRewards(plan.code)}>
                {rewardBusyPlan === plan.code ? 'Redeeming…' : 'Pay with reward points'}
              </Button>
            </div>
          </Card>
        ))}
      </div>

      {subscriptionActive && approved && !suspended && <Card className="p-5 mt-6">
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-start gap-3">
            <BadgeCheck className="w-5 h-5 text-neutral-600 mt-0.5" />
            <div>
              <h2 className="text-xl font-semibold text-neutral-900">Promote your products</h2>
              <p className="text-sm text-neutral-600 mt-1">Open your promotion wallet to top up once, choose multiple products, and manage your campaigns and advertising balance.</p>
            </div>
          </div>
          <Link to="/seller/promotions"><Button>Open promotion wallet <ArrowRight className="w-4 h-4 ml-2" /></Button></Link>
        </div>
      </Card>}

      <Card className="p-5 mt-6">
        <div className="flex items-start gap-3">
          <Clock3 className="w-5 h-5 text-neutral-500 mt-0.5" />
          <div>
            <h3 className="font-semibold text-neutral-900">Secure subscription payments</h3>
            <p className="text-sm text-neutral-600 mt-1">Your subscription activates after your payment is confirmed. If a payment is pending, use “Check payment status” instead of starting another payment. Eligible sellers can request payouts, which are processed automatically when funds are available.</p>
            <Link to="/support" className="inline-block text-sm font-medium text-neutral-900 underline mt-3">Contact support</Link>
          </div>
        </div>
      </Card>
    </div>
  );
}
