import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, BadgeCheck, Clock3, CreditCard, PackagePlus, RefreshCw, Store } from 'lucide-react';
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
const terminalStatuses = new Set(['PAID', 'FAILED', 'CANCELLED', 'TIMEOUT']);

export default function SellerDashboard() {
  usePageMeta('Seller Dashboard | HerStep Collection', 'Manage your HerStep marketplace seller account.');
  const [seller, setSeller] = useState<Seller>(null);
  const [application, setApplication] = useState<Application>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [phone, setPhone] = useState('');
  const [paymentError, setPaymentError] = useState('');
  const [paymentNotice, setPaymentNotice] = useState('');
  const [paymentBusy, setPaymentBusy] = useState(false);
  const [payment, setPayment] = useState<SellerPayment>(null);
  const [idempotencyKeys, setIdempotencyKeys] = useState<Record<string, string>>({});

  async function refreshDashboard() {
    const result: any = await apiFetch('/api/sellers/dashboard');
    setSeller(result.seller || null);
    setApplication(result.application || null);
  }

  useEffect(() => {
    let active = true;
    apiFetch('/api/sellers/dashboard')
      .then((result: any) => {
        if (!active) return;
        setSeller(result.seller || null);
        setApplication(result.application || null);
      })
      .catch((err: any) => {
        if (active) setError(err?.message || 'Could not load your seller dashboard.');
      })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

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
      setPaymentNotice('Check your phone and approve the M-Pesa prompt. Then check the payment status below.');
    } catch (err: any) {
      setPaymentError(err?.message || 'Could not start the subscription payment. Use the same plan button to safely retry or contact support.');
    } finally {
      setPaymentBusy(false);
    }
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
        <div className="flex flex-wrap gap-2"><Link to="/seller/products"><Button><PackagePlus className="w-4 h-4 mr-2" /> My products</Button></Link><Link to="/seller/apply"><Button variant="outline"><Store className="w-4 h-4 mr-2" /> Application details</Button></Link></div>
      </div>

      {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 mb-6">{error}</div>}

      <Card className="p-5 sm:p-6 mb-8">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
          <div className="flex items-start gap-3">
            <div className="rounded-xl bg-neutral-100 p-3"><Store className="w-6 h-6 text-neutral-700" /></div>
            <div>
              <h2 className="text-xl font-semibold text-neutral-900">{seller?.displayName || application?.displayName || 'Your seller shop'}</h2>
              <p className="text-sm text-neutral-600 mt-1">{seller?.businessName || 'HerStep marketplace seller account'}</p>
              <p className="text-xs text-neutral-500 mt-2">Seller status: {seller?.status || application?.status || 'APPLICATION NOT STARTED'}</p>
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

      {approved && !subscriptionActive && <Card className="p-5 mb-5">
        <label htmlFor="seller-mpesa-phone" className="block text-sm font-medium text-neutral-800 mb-2">M-Pesa phone number</label>
        <input id="seller-mpesa-phone" type="tel" autoComplete="tel" value={phone} onChange={event => setPhone(event.target.value)} placeholder="07XXXXXXXX or +2547XXXXXXXX" className="w-full max-w-md rounded-lg border border-neutral-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-neutral-500" />
        <p className="text-xs text-neutral-500 mt-2">The M-Pesa STK prompt will be sent to this number. Total includes the selected plan and KSh 50 badge add-on.</p>
        {paymentError && <p role="alert" className="text-sm text-red-700 mt-3">{paymentError}</p>}
        {paymentNotice && <p role="status" className="text-sm text-neutral-700 mt-3">{paymentNotice}</p>}
        {payment && <div className="mt-4 rounded-lg border border-neutral-200 p-4">
          <p className="text-sm font-semibold text-neutral-900">Latest payment: {payment.status}</p>
          <p className="text-sm text-neutral-600 mt-1">{formatMoney(Number(payment.amount) || 0)} · {payment.planCode} · Reference {payment.paymentId.slice(0, 12)}…</p>
          {payment.failureReason && <p className="text-sm text-red-700 mt-2">{payment.failureReason}</p>}
          {payment.status === 'PENDING' && <Button className="mt-3" variant="outline" onClick={checkPaymentStatus} disabled={paymentBusy}><RefreshCw className="w-4 h-4 mr-2" />{paymentBusy ? 'Checking…' : 'Check payment status'}</Button>}
        </div>}
      </Card>}

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
            <Button variant="outline" className="mt-5 w-full" disabled={!approved || suspended || subscriptionActive || paymentBusy} onClick={() => startSubscription(plan.code)}>
              <CreditCard className="w-4 h-4 mr-2" />{paymentBusy ? 'Please wait…' : subscriptionActive ? 'Subscription active' : approved ? 'Pay with M-Pesa' : 'Approval required'}
            </Button>
          </Card>
        ))}
      </div>

      <Card className="p-5 mt-6">
        <div className="flex items-start gap-3">
          <Clock3 className="w-5 h-5 text-neutral-500 mt-0.5" />
          <div>
            <h3 className="font-semibold text-neutral-900">Secure subscription payments</h3>
            <p className="text-sm text-neutral-600 mt-1">Your subscription activates only after the payment provider confirms the exact amount. If a payment is pending, use “Check payment status” instead of starting a different payment. Seller payouts are not enabled yet.</p>
            <Link to="/support" className="inline-block text-sm font-medium text-neutral-900 underline mt-3">Contact support</Link>
          </div>
        </div>
      </Card>
    </div>
  );
}
