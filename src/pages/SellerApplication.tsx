import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge, Button, Card, Input } from '../components/ui';
import { useApp } from '../context/AppContext';
import { apiFetch } from '../lib/api';
import { usePageMeta } from '../hooks/usePageMeta';

type Application = {
  id: string;
  displayName: string;
  businessName: string;
  phone: string;
  categories: string[];
  description: string;
  status: 'PENDING' | 'APPROVED' | 'REJECTED' | 'SUSPENDED';
  adminReason: string;
  createdAt: string | null;
};

const categories = [
  { value: 'shoes', label: 'Shoes' },
  { value: 'dresses', label: 'Dresses' },
  { value: 'watches', label: 'Watches' },
  { value: 'necklaces', label: 'Necklaces' },
  { value: 'handbags', label: 'Handbags' },
  { value: 'bags', label: 'Bags' },
  { value: 'accessories', label: 'Accessories' },
  { value: 'other', label: 'Other' },
];

const statusCopy: Record<Application['status'], { label: string; variant: 'default' | 'success' | 'warning' | 'danger' }> = {
  PENDING: { label: 'Awaiting review', variant: 'warning' },
  APPROVED: { label: 'Approved', variant: 'success' },
  REJECTED: { label: 'Not approved', variant: 'danger' },
  SUSPENDED: { label: 'Account suspended', variant: 'danger' },
};

export default function SellerApplicationPage() {
  usePageMeta('Sell on HerStep Collection', 'Apply to open your own seller shop on HerStep Collection.');
  const { state } = useApp();
  const [application, setApplication] = useState<Application | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [form, setForm] = useState({
    displayName: '',
    businessName: '',
    phone: '',
    categories: [] as string[],
    description: '',
    termsAccepted: false,
  });

  useEffect(() => {
    let active = true;
    apiFetch('/api/sellers/application')
      .then((result: any) => {
        if (!active) return;
        const saved = result?.application as Application | null;
        setApplication(saved);
        if (saved) {
          setForm(current => ({
            ...current,
            displayName: saved.displayName || '',
            businessName: saved.businessName || '',
            phone: saved.phone || '',
            categories: Array.isArray(saved.categories) ? saved.categories : [],
            description: saved.description || '',
          }));
        } else if (state.user) {
          setForm(current => ({
            ...current,
            displayName: current.displayName || state.user?.name || '',
            phone: current.phone || state.user?.phone || '',
          }));
        }
      })
      .catch((err: any) => {
        if (active) setError(err?.message || 'Could not load your seller application.');
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => { active = false; };
  }, [state.user]);

  const toggleCategory = (value: string) => {
    setForm(current => ({
      ...current,
      categories: current.categories.includes(value)
        ? current.categories.filter(item => item !== value)
        : [...current.categories, value],
    }));
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    setSuccess('');
    try {
      const result: any = await apiFetch('/api/sellers/application', {
        method: 'POST',
        body: JSON.stringify(form),
      });
      setApplication(result.application || null);
      setSuccess(result.message || 'Your application has been submitted.');
    } catch (err: any) {
      setError(err?.message || 'We could not submit your application. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  if (loading) {
    return <div className="max-w-3xl mx-auto px-4 py-12"><Card className="p-8 text-center text-sm text-neutral-500">Loading seller application…</Card></div>;
  }

  const locked = application?.status === 'PENDING' || application?.status === 'APPROVED' || application?.status === 'SUSPENDED';

  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-10 animate-fadeIn">
      <div className="mb-8">
        <p className="text-sm font-medium text-neutral-500 mb-2">HERSTEP MARKETPLACE</p>
        <h1 className="text-3xl font-bold text-neutral-900">Sell on HerStep Collection</h1>
        <p className="text-neutral-600 mt-3 max-w-2xl">
          Apply to open your own shop, list products under your public shop name, and manage your seller account separately from customer shopping.
        </p>
      </div>

      {application && (
        <Card className="p-5 mb-6">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-semibold text-neutral-900">Your application status</h2>
            <Badge variant={statusCopy[application.status]?.variant || 'default'}>{statusCopy[application.status]?.label || application.status}</Badge>
          </div>
          <p className="text-sm text-neutral-600 mt-3">
            Shop name: <span className="font-medium text-neutral-900">{application.displayName}</span>
          </p>
          {application.adminReason && (
            <p className="text-sm text-neutral-600 mt-2">Admin note: {application.adminReason}</p>
          )}
          {application.status === 'PENDING' && <p className="text-sm text-neutral-600 mt-2">HerStep will review your details before activating seller access.</p>}
          {application.status === 'APPROVED' && <p className="text-sm text-neutral-600 mt-2">Your application is approved. Seller listings and subscription billing will be enabled in a later rollout step.</p>}
          {application.status === 'SUSPENDED' && <p className="text-sm text-neutral-600 mt-2">Contact HerStep Support if you believe this suspension was made in error.</p>}
          {application.status === 'REJECTED' && <p className="text-sm text-neutral-600 mt-2">You can update your application and submit it again.</p>}
        </Card>
      )}

      {locked ? (
        <Card className="p-6">
          <h2 className="font-semibold text-neutral-900">What happens next?</h2>
          <p className="text-sm text-neutral-600 mt-2">We’ll show your next steps here when seller access and subscription billing are ready. No subscription payment has been taken on this page.</p>
          <Link to="/support" className="inline-block text-sm font-medium text-neutral-900 underline mt-4">Contact HerStep Support</Link>
        </Card>
      ) : (
        <Card className="p-6 sm:p-8">
          <h2 className="text-lg font-semibold text-neutral-900 mb-5">{application?.status === 'REJECTED' ? 'Update and resubmit' : 'Seller application'}</h2>
          <form onSubmit={submit} className="space-y-5">
            <Input label="Public shop name" value={form.displayName} onChange={e => setForm({ ...form, displayName: e.target.value })} placeholder="The name customers will see" minLength={2} maxLength={60} required />
            <Input label="Business name (optional)" value={form.businessName} onChange={e => setForm({ ...form, businessName: e.target.value })} placeholder="Registered or trading name" maxLength={100} />
            <Input label="Contact phone number" value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} placeholder="+254 7XX XXX XXX" maxLength={24} required />
            <div>
              <p className="block text-sm font-medium text-neutral-700 mb-2">What do you plan to sell?</p>
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                {categories.map(category => (
                  <label key={category.value} className="flex items-center gap-2 rounded-lg border border-neutral-200 px-3 py-3 text-sm text-neutral-700">
                    <input type="checkbox" checked={form.categories.includes(category.value)} onChange={() => toggleCategory(category.value)} />
                    {category.label}
                  </label>
                ))}
              </div>
            </div>
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1.5">Tell us about your shop (optional)</label>
              <textarea value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} maxLength={500} rows={4} className="w-full px-3.5 py-2.5 border border-neutral-300 rounded-lg text-sm focus:border-neutral-900 focus:ring-0" placeholder="Describe your products and business." />
              <p className="text-xs text-neutral-400 mt-1">{form.description.length}/500 characters</p>
            </div>
            <label className="flex items-start gap-3 text-sm text-neutral-600">
              <input type="checkbox" className="mt-1" checked={form.termsAccepted} onChange={e => setForm({ ...form, termsAccepted: e.target.checked })} required />
              <span>I confirm these details are accurate and agree to the HerStep seller application terms. I understand that submitting an application does not guarantee approval.</span>
            </label>
            {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
            {success && <div role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{success}</div>}
            <Button type="submit" size="lg" className="w-full" loading={submitting}>Submit seller application</Button>
            <p className="text-xs text-neutral-500">Applications are reviewed by HerStep admins. Subscription payments and product publishing are not enabled yet.</p>
          </form>
        </Card>
      )}
    </div>
  );
}
