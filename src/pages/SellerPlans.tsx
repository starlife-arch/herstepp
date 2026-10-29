import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, BadgeCheck, CalendarClock, CreditCard, RefreshCw } from 'lucide-react';
import { Badge, Button, Card } from '../components/ui';
import { apiFetch } from '../lib/api';
import { usePageMeta } from '../hooks/usePageMeta';

const plans = [
  { code: 'STARTER', name: 'Starter', price: 150, limit: '20 active products', description: 'For a small shop getting started.' },
  { code: 'STANDARD', name: 'Standard', price: 350, limit: 'Up to 100 active products', description: 'For shops building a steady catalogue.' },
  { code: 'GROWTH', name: 'Growth', price: 800, limit: 'Up to 1,000 active products', description: 'For growing product ranges.' },
  { code: 'UNLIMITED', name: 'Unlimited', price: 1500, limit: 'Unlimited active products', description: 'For large catalogues.' },
];
const formatMoney = (amount: number) => new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES', maximumFractionDigits: 0 }).format(amount);
const dateLabel = (value?: string | null) => {
  if (!value) return 'Not recorded';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Not recorded' : date.toLocaleDateString('en-KE', { year: 'numeric', month: 'short', day: 'numeric' });
};

export default function SellerPlans() {
  usePageMeta('Seller Plans | HerStep Collection', 'View your current seller subscription and manage your plan.');
  const [seller, setSeller] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [phone, setPhone] = useState('');
  const [selected, setSelected] = useState<string | null>(null);
  const [durationMonths, setDurationMonths] = useState(1);
  const [payment, setPayment] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function load() {
    const result: any = await apiFetch('/api/sellers/dashboard');
    setSeller(result.seller || null);
    setPhone(current => current || result.seller?.defaultPayoutPhone || '');
  }
  useEffect(() => {
    let active = true;
    apiFetch('/api/sellers/dashboard').then((result: any) => {
      if (active) { setSeller(result.seller || null); setPhone(result.seller?.defaultPayoutPhone || ''); }
    }).catch((e: any) => { if (active) setError(e?.message || 'Could not load your subscription.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  async function startPayment() {
    if (!selected) return;
    if (!phone.trim()) { setError('Enter the M-Pesa number that should receive the payment prompt.'); return; }
    setBusy(true); setError(''); setNotice('');
    try {
      const result: any = await apiFetch('/api/sellers/subscription', {
        method: 'POST',
        body: JSON.stringify({ planCode: selected, durationMonths, phone: phone.trim(), idempotencyKey: 'seller-plan-' + crypto.randomUUID() }),
      });
      setPayment(result.payment || null);
      setSelected(null);
      setNotice('Approve the M-Pesa prompt. Your plan changes only after payment is verified.');
    } catch (e: any) { setError(e?.message || 'Could not start payment.'); }
    finally { setBusy(false); }
  }
  async function checkPayment() {
    if (!payment?.paymentId) return;
    setBusy(true); setError('');
    try {
      const result: any = await apiFetch('/api/sellers/subscription?paymentId=' + encodeURIComponent(payment.paymentId));
      setPayment(result.payment || null);
      if (result.payment?.status === 'PAID') { setNotice('Payment verified and your subscription is active.'); await load(); }
      else if (['FAILED', 'CANCELLED', 'TIMEOUT'].includes(result.payment?.status)) setNotice(result.payment.failureReason || 'Payment did not complete. You can try again.');
      else setNotice('Payment is still pending. Approve the prompt, then check again.');
    } catch (e: any) { setError(e?.message || 'Could not check payment status.'); }
    finally { setBusy(false); }
  }

  const expiry = seller?.subscriptionExpiresAt ? new Date(seller.subscriptionExpiresAt) : null;
  const active = seller?.billingStatus === 'ACTIVE' && expiry && expiry.getTime() > Date.now();
  const status = active ? 'Active' : seller?.billingStatus === 'ACTIVE' ? 'Expired' : 'Inactive';
  const currentPlan = plans.find(p => p.code === seller?.planCode);
  const termDiscount = durationMonths === 12 ? 20 : durationMonths === 6 ? 10 : durationMonths === 3 ? 5 : 0;
  const selectedPlan = plans.find(p => p.code === selected);
  const selectedSubtotal = (selectedPlan?.price || 0) * durationMonths;
  const selectedDiscount = Math.round(selectedSubtotal * termDiscount / 100);
  const selectedTotal = selectedSubtotal - selectedDiscount + 50 * durationMonths;
  if (loading) return <div className="max-w-6xl mx-auto px-4 py-10"><Card className="p-6">Loading seller plans…</Card></div>;

  return <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
    <Link to="/seller/dashboard" className="inline-flex items-center gap-2 text-sm text-neutral-500 mb-5"><ArrowLeft className="w-4 h-4" /> Back to seller dashboard</Link>
    <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 mb-7">
      <div><p className="text-xs font-semibold tracking-wide text-neutral-500 mb-2">HERSTEP MARKETPLACE</p><h1 className="text-3xl font-bold">Seller Plans</h1><p className="text-neutral-600 mt-2">Manage your subscription and see the plan that keeps your shop active.</p></div>
      <Button variant="outline" onClick={() => load().catch((e: any) => setError(e?.message || 'Could not refresh subscription.'))}><RefreshCw className="w-4 h-4 mr-2" /> Refresh</Button>
    </div>
    {error && <p role="alert" className="rounded-lg bg-red-50 text-red-700 p-3 text-sm mb-4">{error}</p>}
    {notice && <p role="status" className="rounded-lg bg-neutral-100 p-3 text-sm mb-4">{notice}</p>}
    <Card className="p-5 sm:p-6 mb-8">
      <div className="flex items-start justify-between gap-3"><div><p className="text-sm text-neutral-500">Your current subscription</p><h2 className="text-2xl font-bold mt-1">{currentPlan?.name || seller?.planCode || 'No plan selected'}</h2></div><Badge variant={active ? 'success' : 'warning'}>{status}</Badge></div>
      <div className="grid sm:grid-cols-2 lg:grid-cols-4 gap-3 mt-5">
        <div className="rounded-lg border p-3"><p className="text-xs text-neutral-500">Plan amount</p><p className="font-semibold mt-1">{seller?.planAmount != null ? formatMoney(Number(seller.planAmount)) : currentPlan ? formatMoney(currentPlan.price) : 'Not recorded'}</p></div>
        <div className="rounded-lg border p-3"><p className="text-xs text-neutral-500">Purchase / start date</p><p className="font-semibold mt-1">{dateLabel(seller?.subscriptionStartedAt || seller?.subscriptionPurchasedAt || seller?.createdAt)}</p></div>
        <div className="rounded-lg border p-3"><p className="text-xs text-neutral-500">Expiry date</p><p className="font-semibold mt-1">{dateLabel(seller?.subscriptionExpiresAt)}</p></div>
        <div className="rounded-lg border p-3"><p className="text-xs text-neutral-500">Renewal date</p><p className="font-semibold mt-1">{active ? dateLabel(seller?.subscriptionExpiresAt) : 'Renew to reactivate'}</p></div>
      </div>
      <p className="text-xs text-neutral-500 mt-4">The renewal date is the current expiry date. A payment receipt/reference is shown after a new payment is started.</p>
    </Card>
    {payment && <Card className="p-4 mb-6"><p className="font-semibold">Latest payment: {payment.status}</p><p className="text-sm text-neutral-600 mt-1">{formatMoney(Number(payment.amount) || 0)} · {payment.planCode} · Reference {String(payment.paymentId || '').slice(0, 12)}…</p>{payment.failureReason && <p className="text-sm text-red-700 mt-2">{payment.failureReason}</p>}{payment.status === 'PENDING' && <Button className="mt-3" variant="outline" disabled={busy} onClick={checkPayment}><RefreshCw className="w-4 h-4 mr-2" /> Check payment status</Button>}</Card>}
    <div className="mb-4"><h2 className="text-2xl font-bold">Choose a plan</h2><p className="text-sm text-neutral-600 mt-1">Save with longer terms: 3 months gets 5% off plan fees, 6 months gets 10% off, and 12 months gets 20% off. The KSh 50 badge subscription is charged per month and is not discounted.</p></div>
    <div className="flex flex-wrap items-center gap-3 mb-4"><label htmlFor="seller-billing-term" className="text-sm font-medium">Billing term</label><select id="seller-billing-term" value={durationMonths} onChange={e => setDurationMonths(Number(e.target.value))} className="rounded-lg border px-3 py-2 text-sm"><option value={1}>1 month · no discount</option><option value={3}>3 months · 5% off plan fee</option><option value={6}>6 months · 10% off plan fee</option><option value={12}>12 months · 20% off plan fee</option></select></div>
    <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
      {plans.map(plan => <Card key={plan.code} className="p-5 flex flex-col">
        <h3 className="text-lg font-semibold">{plan.name}</h3><p className="text-sm text-neutral-500 mt-1 min-h-10">{plan.description}</p>
        <p className="mt-4"><span className="text-2xl font-bold">{formatMoney(plan.price * durationMonths - Math.round(plan.price * durationMonths * termDiscount / 100) + 50 * durationMonths)}</span><span className="text-xs text-neutral-500"> / {durationMonths} month{durationMonths === 1 ? "" : "s"}</span></p>
        <p className="text-xs text-neutral-500 mt-1">{formatMoney(plan.price * durationMonths)} plan fee minus {termDiscount}% discount + {formatMoney(50 * durationMonths)} badge subscription</p>
        <div className="border-t my-4" /><p className="text-sm">{plan.limit}</p><p className="text-xs text-neutral-500 mt-3">Verified badge subscription is included in the total; identity verification remains subject to the platform's verification process.</p>
        <Button className="w-full mt-5" variant="outline" disabled={seller?.status !== 'ACTIVE' || busy} onClick={() => { setSelected(plan.code); setError(''); }}>{active ? seller?.planCode === plan.code ? 'Renew this plan' : 'Switch plan' : 'Choose plan'}</Button>
      </Card>)}
    </div>
    {selected && <div className="fixed inset-0 z-50 bg-black/50 p-4 flex items-center justify-center" role="dialog" aria-modal="true" aria-labelledby="plan-pay-title"><Card className="w-full max-w-md p-6"><h2 id="plan-pay-title" className="text-xl font-semibold">Pay for {plans.find(p => p.code === selected)?.name}</h2><p className="text-sm text-neutral-600 mt-2">Total due for {durationMonths} month{durationMonths === 1 ? "" : "s"}: {formatMoney(selectedTotal)}. You save {formatMoney(selectedDiscount)} on the plan fee.</p><label htmlFor="seller-plan-phone" className="block text-sm font-medium mt-4 mb-2">M-Pesa phone number</label><input id="seller-plan-phone" type="tel" value={phone} onChange={e => setPhone(e.target.value)} placeholder="07XXXXXXXX or +2547XXXXXXXX" className="w-full rounded-lg border px-3 py-2" />{error && <p role="alert" className="text-sm text-red-700 mt-3">{error}</p>}<div className="flex gap-3 mt-5"><Button variant="outline" className="flex-1" disabled={busy} onClick={() => setSelected(null)}>Cancel</Button><Button className="flex-1" disabled={busy || !phone.trim()} onClick={startPayment}><CreditCard className="w-4 h-4 mr-2" />{busy ? 'Starting…' : 'Pay with M-Pesa'}</Button></div></Card></div>}
    <Card className="p-4 mt-7"><div className="flex gap-3"><CalendarClock className="w-5 h-5 text-neutral-500 mt-0.5" /><div><h3 className="font-semibold">Subscription dates and payments</h3><p className="text-sm text-neutral-600 mt-1">Your plan only changes after the payment provider confirms the payment. Keep your payment reference if you contact support.</p><Link to="/support" className="inline-block text-sm underline mt-2">Contact support</Link></div></div></Card>
  </div>;
}
