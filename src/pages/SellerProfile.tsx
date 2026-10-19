import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, CheckCircle2, CreditCard, RefreshCw, Save, Store } from 'lucide-react';
import { Button, Card } from '../components/ui';
import { apiFetch } from '../lib/api';
import { usePageMeta } from '../hooks/usePageMeta';

type Profile = {
  sellerId: string;
  displayName: string;
  businessName: string;
  phone: string;
  defaultPayoutPhone: string;
  description: string;
  categories: string[];
  sellerStatus: string;
  billingStatus: string;
  planCode: string;
  subscriptionExpiresAt: string | null;
  businessNameChangedAt: string | null;
  nextBusinessNameChangeAt: string | null;
};
type NamePayment = { paymentId: string; status: string; amount: number; currency: string; newBusinessName: string; failureReason?: string | null } | null;
const categories = [
  { value: 'shoes', label: 'Shoes' }, { value: 'dresses', label: 'Dresses' },
  { value: 'watches', label: 'Watches' }, { value: 'necklaces', label: 'Necklaces' },
  { value: 'handbags', label: 'Handbags' }, { value: 'bags', label: 'Bags' },
  { value: 'accessories', label: 'Accessories' }, { value: 'other', label: 'Other' },
];
const field = 'w-full rounded-lg border border-neutral-300 bg-white px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-neutral-400';
const formatDate = (value?: string | null) => value && !Number.isNaN(new Date(value).getTime()) ? new Date(value).toLocaleDateString('en-KE', { year: 'numeric', month: 'short', day: 'numeric' }) : 'Not set';

export default function SellerProfile() {
  usePageMeta('Business Profile | HerStep Collection', 'Manage your marketplace business profile and payout details.');
  const [profile, setProfile] = useState<Profile | null>(null);
  const [displayName, setDisplayName] = useState('');
  const [phone, setPhone] = useState('');
  const [defaultPayoutPhone, setDefaultPayoutPhone] = useState('');
  const [description, setDescription] = useState('');
  const [selectedCategories, setSelectedCategories] = useState<string[]>([]);
  const [newBusinessName, setNewBusinessName] = useState('');
  const [nameChangePhone, setNameChangePhone] = useState('');
  const [payment, setPayment] = useState<NamePayment>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [paying, setPaying] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  async function loadProfile() {
    const result: any = await apiFetch('/api/sellers/profile');
    const p = result.profile as Profile;
    setProfile(p);
    setDisplayName(p.displayName || '');
    setPhone(p.phone || '');
    setDefaultPayoutPhone(p.defaultPayoutPhone || '');
    setDescription(p.description || '');
    setSelectedCategories(Array.isArray(p.categories) ? p.categories : []);
    setNewBusinessName(p.businessName || '');
    setNameChangePhone(p.defaultPayoutPhone || p.phone || '');
  }

  useEffect(() => {
    let active = true;
    apiFetch('/api/sellers/profile').then((result: any) => {
      if (!active) return;
      const p = result.profile as Profile;
      setProfile(p);
      setDisplayName(p.displayName || '');
      setPhone(p.phone || '');
      setDefaultPayoutPhone(p.defaultPayoutPhone || '');
      setDescription(p.description || '');
      setSelectedCategories(Array.isArray(p.categories) ? p.categories : []);
      setNewBusinessName(p.businessName || '');
      setNameChangePhone(p.defaultPayoutPhone || p.phone || '');
    }).catch((err: any) => { if (active) setError(err?.message || 'Could not load your business profile.'); })
      .finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!payment?.paymentId || payment.status !== 'PENDING') return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let attempts = 0;
    const poll = async () => {
      if (cancelled || attempts >= 24) return;
      attempts++;
      try {
        const result: any = await apiFetch('/api/sellers/profile?paymentId=' + encodeURIComponent(payment.paymentId));
        const current = result.payment as NamePayment;
        if (!cancelled && current) {
          setPayment(current);
          if (current.status === 'PAID') {
            setNotice('Payment confirmed. Your business name has been updated.');
            await loadProfile();
            return;
          }
          if (['FAILED', 'CANCELLED', 'TIMEOUT'].includes(current.status)) {
            setNotice(current.failureReason || 'The payment was not completed. You can try again.');
            return;
          }
        }
      } catch { /* Keep polling while the provider status is pending. */ }
      if (!cancelled && attempts < 24) timer = setTimeout(poll, 5000);
      else if (!cancelled) setNotice('Payment is still pending. We will not change your business name until PrintPay confirms it.');
    };
    timer = setTimeout(poll, 3500);
    return () => { cancelled = true; if (timer) clearTimeout(timer); };
  }, [payment?.paymentId, payment?.status]);

  async function saveProfile(event: React.FormEvent) {
    event.preventDefault(); setSaving(true); setError(''); setNotice('');
    try {
      const result: any = await apiFetch('/api/sellers/profile', {
        method: 'PATCH',
        body: JSON.stringify({ displayName, phone, defaultPayoutPhone, description, categories: selectedCategories }),
      });
      setProfile(result.profile || profile);
      setNotice(result.message || 'Business profile saved.');
      await loadProfile();
    } catch (err: any) { setError(err?.message || 'Could not save your profile.'); }
    finally { setSaving(false); }
  }

  async function requestNameChange(event: React.FormEvent) {
    event.preventDefault(); setPaying(true); setError(''); setNotice('');
    try {
      const result: any = await apiFetch('/api/sellers/profile', {
        method: 'POST',
        body: JSON.stringify({
          action: 'REQUEST_BUSINESS_NAME_CHANGE', businessName: newBusinessName,
          phone: nameChangePhone, idempotencyKey: 'name-' + crypto.randomUUID(),
        }),
      });
      setPayment(result.payment || null);
      setNotice('Approve the KSh 100 M-Pesa prompt. Your new name will be saved only after payment is confirmed.');
    } catch (err: any) { setError(err?.message || 'Could not start the business name change.'); }
    finally { setPaying(false); }
  }

  async function checkNamePayment() {
    if (!payment?.paymentId) return;
    setPaying(true); setError('');
    try {
      const result: any = await apiFetch('/api/sellers/profile?paymentId=' + encodeURIComponent(payment.paymentId));
      setPayment(result.payment || payment);
      if (result.payment?.status === 'PAID') { setNotice('Payment confirmed. Your business name has been updated.'); await loadProfile(); }
      else setNotice(result.payment?.failureReason || 'Payment is still pending. Approve the M-Pesa prompt if it is still on your phone.');
    } catch (err: any) { setError(err?.message || 'Could not check payment status.'); }
    finally { setPaying(false); }
  }

  const cooldown = profile?.nextBusinessNameChangeAt && new Date(profile.nextBusinessNameChangeAt).getTime() > Date.now();
  return <main className="max-w-4xl mx-auto px-4 sm:px-6 py-8">
    <Link to="/seller/dashboard" className="inline-flex items-center gap-2 text-sm text-neutral-600 hover:text-neutral-900 mb-5"><ArrowLeft className="w-4 h-4" /> Seller dashboard</Link>
    <div className="mb-7"><p className="text-xs font-semibold tracking-wide text-neutral-500">HERSTEP MARKETPLACE</p><h1 className="text-3xl font-bold mt-1">Business profile</h1><p className="text-sm text-neutral-600 mt-2">Update your public seller details, save your default payout number, and request paid business-name changes.</p></div>
    {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 mb-4">{error}</div>}
    {notice && <div role="status" className="rounded-lg border border-neutral-200 bg-neutral-50 p-3 text-sm text-neutral-800 mb-4">{notice}</div>}
    {loading ? <Card className="p-8 text-center text-sm text-neutral-500">Loading business profile…</Card> : <>
      {profile && <Card className="p-5 mb-5">
        <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="text-lg font-semibold">{profile.businessName || profile.displayName || 'Your seller shop'}</h2><p className="text-sm text-neutral-600 mt-1">Seller status: {profile.sellerStatus === 'ACTIVE' && profile.billingStatus !== 'ACTIVE' ? 'Approved — plan required' : profile.sellerStatus}</p>{profile.planCode && <p className="text-sm text-neutral-600 mt-1">Current plan: {profile.planCode} · expires {formatDate(profile.subscriptionExpiresAt)}</p>}</div>{profile.billingStatus === 'ACTIVE' && <Link to={'/seller/shop/' + encodeURIComponent(profile.sellerId)} className="inline-flex items-center text-sm font-medium underline"><Store className="w-4 h-4 mr-1" /> View public shop</Link>}</div>
      </Card>}
      <Card className="p-5 mb-5"><h2 className="text-lg font-semibold mb-4">Business details</h2>
        <form onSubmit={saveProfile} className="space-y-4">
          <div><label className="block text-sm font-medium mb-1" htmlFor="seller-profile-display-name">Seller display name</label><input id="seller-profile-display-name" className={field} maxLength={60} value={displayName} onChange={e => setDisplayName(e.target.value)} required /></div>
          <div><label className="block text-sm font-medium mb-1" htmlFor="seller-profile-phone">Business contact phone</label><input id="seller-profile-phone" className={field} type="tel" value={phone} onChange={e => setPhone(e.target.value)} required placeholder="07XXXXXXXX or +254…" /></div>
          <div><label className="block text-sm font-medium mb-1" htmlFor="seller-profile-description">Shop description</label><textarea id="seller-profile-description" className={field} rows={3} maxLength={500} value={description} onChange={e => setDescription(e.target.value)} placeholder="Tell customers about your shop." /></div>
          <fieldset><legend className="text-sm font-medium mb-2">Product categories</legend><div className="grid grid-cols-2 sm:grid-cols-4 gap-2">{categories.map(item => <label key={item.value} className="flex items-center gap-2 rounded-lg border p-2 text-sm"><input type="checkbox" checked={selectedCategories.includes(item.value)} onChange={e => setSelectedCategories(old => e.target.checked ? [...old, item.value] : old.filter(value => value !== item.value))} />{item.label}</label>)}</div></fieldset>
          <div><label className="block text-sm font-medium mb-1" htmlFor="seller-default-payout-phone">Default M-Pesa payout number</label><input id="seller-default-payout-phone" className={field} type="tel" value={defaultPayoutPhone} onChange={e => setDefaultPayoutPhone(e.target.value)} placeholder="07XXXXXXXX or +254…" /><p className="text-xs text-neutral-500 mt-1">Payout requests will prefill this number. You can still enter a different number for an individual payout.</p></div>
          <Button type="submit" disabled={saving} className="w-full sm:w-auto"><Save className="w-4 h-4 mr-2" />{saving ? 'Saving…' : 'Save profile'}</Button>
        </form>
      </Card>
      <Card className="p-5"><h2 className="text-lg font-semibold">Change business name</h2><p className="text-sm text-neutral-600 mt-1">A business-name change costs KSh 100 and is limited to once every five months. Admin can make audited corrections or overrides.</p>
        {cooldown && <p className="text-sm text-amber-800 bg-amber-50 rounded-lg p-3 mt-3">You can request another paid name change from {formatDate(profile?.nextBusinessNameChangeAt)}.</p>}
        <form onSubmit={requestNameChange} className="space-y-3 mt-4">
          <div><label className="block text-sm font-medium mb-1" htmlFor="seller-new-business-name">New business name</label><input id="seller-new-business-name" className={field} maxLength={100} minLength={2} value={newBusinessName} onChange={e => setNewBusinessName(e.target.value)} required /></div>
          <div><label className="block text-sm font-medium mb-1" htmlFor="seller-name-change-phone">M-Pesa number for KSh 100 payment</label><input id="seller-name-change-phone" className={field} type="tel" value={nameChangePhone} onChange={e => setNameChangePhone(e.target.value)} required placeholder="07XXXXXXXX or +254…" /></div>
          <Button type="submit" disabled={paying || Boolean(cooldown) || !profile?.sellerId}><CreditCard className="w-4 h-4 mr-2" />{paying ? 'Starting payment…' : 'Pay KSh 100 and request change'}</Button>
        </form>
        {payment && <div className="mt-4 rounded-lg border p-4"><p className="text-sm font-semibold">Name-change payment: {payment.status}</p><p className="text-sm text-neutral-600 mt-1">KSh {payment.amount} · {payment.newBusinessName}</p>{payment.status === 'PENDING' && <Button variant="outline" className="mt-3" onClick={checkNamePayment} disabled={paying}><RefreshCw className="w-4 h-4 mr-2" />Check payment status</Button>}{payment.status === 'PAID' && <p className="text-sm text-neutral-700 mt-2"><CheckCircle2 className="w-4 h-4 inline mr-1" />Name updated</p>}</div>}
      </Card>
    </>}
  </main>;
}
