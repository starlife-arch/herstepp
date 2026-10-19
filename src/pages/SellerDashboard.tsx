import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, BadgeCheck, Clock3, CreditCard, Store } from 'lucide-react';
import { Badge, Button, Card } from '../components/ui';
import { apiFetch } from '../lib/api';
import { usePageMeta } from '../hooks/usePageMeta';

type Seller = {
  displayName?: string;
  businessName?: string;
  status?: string;
  planCode?: string;
  billingStatus?: string;
  verificationBadge?: boolean;
  createdAt?: string | null;
} | null;

type Application = {
  displayName?: string;
  status?: string;
  adminReason?: string;
} | null;

const plans = [
  { code: 'STARTER', name: 'Starter', price: 150, limit: '20 active products', description: 'For a small shop getting started.' },
  { code: 'STANDARD', name: 'Standard', price: 350, limit: 'Up to 100 active products', description: 'For shops building a steady catalogue.' },
  { code: 'GROWTH', name: 'Growth', price: 800, limit: 'Up to 1,000 active products', description: 'For growing product ranges.' },
  { code: 'UNLIMITED', name: 'Unlimited', price: 1500, limit: 'Unlimited active products', description: 'For large catalogues.' },
];

const formatMoney = (amount: number) => new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES', maximumFractionDigits: 0 }).format(amount);

export default function SellerDashboard() {
  usePageMeta('Seller Dashboard | HerStep Collection', 'Manage your HerStep marketplace seller account.');
  const [seller, setSeller] = useState<Seller>(null);
  const [application, setApplication] = useState<Application>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

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

  if (loading) return <div className="max-w-6xl mx-auto px-4 py-12"><Card className="p-8 text-center text-sm text-neutral-500">Loading seller dashboard…</Card></div>;

  const approved = seller?.status === 'ACTIVE';
  const suspended = seller?.status === 'SUSPENDED' || application?.status === 'SUSPENDED';

  return (
    <div className="max-w-6xl mx-auto px-4 sm:px-6 py-10 animate-fadeIn">
      <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-8">
        <div>
          <p className="text-xs font-semibold tracking-wide text-neutral-500 mb-2">HERSTEP MARKETPLACE</p>
          <h1 className="text-3xl font-bold text-neutral-900">Seller dashboard</h1>
          <p className="text-neutral-600 mt-2">Your seller account, subscription options, and next steps in one place.</p>
        </div>
        <Link to="/seller/apply"><Button variant="outline"><Store className="w-4 h-4 mr-2" /> Application details</Button></Link>
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
        {approved && <p className="text-sm text-neutral-600 mt-4">Your seller account is approved. Product publishing, customer messaging, and paid subscription activation remain disabled until their secure rollout is complete.</p>}
        {suspended && <p className="text-sm text-neutral-600 mt-3">Seller access is currently suspended. Contact support if you need help resolving this.</p>}
        {!approved && !suspended && <div className="mt-4"><p className="text-sm text-neutral-600 mb-3">{application?.status === 'PENDING' ? 'Your application is awaiting admin review. You can check back here for updates.' : application?.status === 'REJECTED' ? (application.adminReason || 'Please review your application details and resubmit.') : 'Submit a seller application to start the review process.'}</p><Link to="/seller/apply"><Button>{application?.status === 'REJECTED' ? 'Update application' : application?.status === 'PENDING' ? 'View application' : 'Apply to sell'} <ArrowRight className="w-4 h-4 ml-2" /></Button></Link></div>}
      </Card>

      <div className="mb-5">
        <h2 className="text-2xl font-bold text-neutral-900">Seller subscription plans</h2>
        <p className="text-sm text-neutral-600 mt-2">Proposed monthly pricing. Each plan includes the mandatory verified-badge add-on at KSh 50/month.</p>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        {plans.map(plan => (
          <Card key={plan.code} className="p-5 flex flex-col">
            <h3 className="text-lg font-semibold text-neutral-900">{plan.name}</h3>
            <p className="text-sm text-neutral-500 mt-1 min-h-10">{plan.description}</p>
            <div className="mt-4"><span className="text-2xl font-bold text-neutral-900">{formatMoney(plan.price + 50)}</span><span className="text-xs text-neutral-500"> / month</span></div>
            <p className="text-xs text-neutral-500 mt-1">{formatMoney(plan.price)} plan + {formatMoney(50)} badge add-on</p>
            <div className="border-t border-neutral-100 my-4" />
            <p className="text-sm font-medium text-neutral-800">{plan.limit}</p>
            <p className="text-sm text-neutral-600 mt-3">Verified badge add-on: {formatMoney(50)}/month</p>
            <Button variant="outline" className="mt-5 w-full" disabled><CreditCard className="w-4 h-4 mr-2" /> Billing not enabled</Button>
          </Card>
        ))}
      </div>

      <Card className="p-5 mt-6">
        <div className="flex items-start gap-3">
          <Clock3 className="w-5 h-5 text-neutral-500 mt-0.5" />
          <div>
            <h3 className="font-semibold text-neutral-900">Payments are not being collected yet</h3>
            <p className="text-sm text-neutral-600 mt-1">This dashboard is informational only. No subscription can be purchased here, no verified badge is activated by this page, and no product publishing or seller payouts are enabled. M-Pesa billing will be added after server-side payment verification and ledger testing.</p>
            <Link to="/support" className="inline-block text-sm font-medium text-neutral-900 underline mt-3">Contact support</Link>
          </div>
        </div>
      </Card>
    </div>
  );
}
