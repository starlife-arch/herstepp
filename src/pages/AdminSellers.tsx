import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, BadgeCheck, ClipboardCheck, RefreshCw, ShieldCheck, Store, Save } from 'lucide-react';
import { Badge, Button, Card, EmptyState, Input, getStatusBadge, formatDateTime } from '../components/ui';
import { apiFetch } from '../lib/api';
import { usePageMeta } from '../hooks/usePageMeta';

type SellerApplication = {
  id: string;
  applicantUid: string;
  applicantEmail: string;
  displayName: string;
  businessName: string;
  phone: string;
  categories: string[];
  description: string;
  status: string;
  verificationBadge: boolean;
  adminReason: string;
  createdAt: string | null;
  updatedAt: string | null;
};

const filters = [
  { value: 'PENDING', label: 'Pending' },
  { value: 'APPROVED', label: 'Approved' },
  { value: 'REJECTED', label: 'Rejected' },
  { value: 'SUSPENDED', label: 'Suspended' },
  { value: 'ALL', label: 'All applications' },
];

export default function AdminSellers() {
  usePageMeta('Seller Applications | HerStep Admin', 'Review seller marketplace applications.');
  const [status, setStatus] = useState('PENDING');
  const [applications, setApplications] = useState<SellerApplication[]>([]);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [profileEdits, setProfileEdits] = useState<Record<string, { displayName: string; businessName: string }>>({});
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const result: any = await apiFetch(`/api/admin/sellers/applications?status=${encodeURIComponent(status)}`);
      setApplications(Array.isArray(result.applications) ? result.applications : []);
    } catch (err: any) {
      setError(err?.message || 'Could not load seller applications.');
    } finally {
      setLoading(false);
    }
  }, [status]);

  useEffect(() => { load(); }, [load]);

  const saveBusinessProfile = async (application: SellerApplication) => {
    const edit = profileEdits[application.applicantUid] || { displayName: application.displayName, businessName: application.businessName };
    if (edit.displayName.trim().length < 2 || edit.businessName.trim().length < 2) {
      setError('Display name and business name must each be at least 2 characters.');
      return;
    }
    setBusyId(application.applicantUid); setError(''); setNotice('');
    try {
      const result: any = await apiFetch('/api/admin/sellers/profile', {
        method: 'PATCH',
        body: JSON.stringify({
          sellerUid: application.applicantUid,
          displayName: edit.displayName,
          businessName: edit.businessName,
          reason: (reasons[application.applicantUid] || 'Admin profile correction').trim(),
        }),
      });
      setNotice(result.message || 'Seller business profile updated.');
      await load();
    } catch (err: any) {
      setError(err?.message || 'Could not update the seller business profile.');
    } finally { setBusyId(''); }
  };

  const toggleVerification = async (application: SellerApplication) => {
    const nextValue = !application.verificationBadge;
    setBusyId(application.applicantUid);
    setError('');
    setNotice('');
    try {
      const suppliedReason = (reasons[application.applicantUid] || '').trim();
      const reason = suppliedReason || (nextValue ? 'Verified after admin business review' : 'Verification badge revoked by admin');
      const result: any = await apiFetch('/api/admin/sellers/profile', {
        method: 'PATCH',
        body: JSON.stringify({ sellerUid: application.applicantUid, verificationBadge: nextValue, reason }),
      });
      setNotice(result.message || 'Seller verification updated.');
      await load();
    } catch (err: any) {
      setError(err?.message || 'Could not update seller verification.');
    } finally {
      setBusyId('');
    }
  };

  const updateApplication = async (application: SellerApplication, nextStatus: string) => {
    if (nextStatus === 'REJECTED' && (reasons[application.applicantUid] || '').trim().length < 3) {
      setError('Enter a short reason before rejecting an application.');
      return;
    }
    setBusyId(application.applicantUid);
    setError('');
    setNotice('');
    try {
      const result: any = await apiFetch('/api/admin/sellers/applications', {
        method: 'PATCH',
        body: JSON.stringify({
          applicantUid: application.applicantUid,
          status: nextStatus,
          reason: reasons[application.applicantUid] || '',
        }),
      });
      setNotice(result.message || 'Seller application updated.');
      await load();
    } catch (err: any) {
      setError(err?.message || 'Could not update seller application.');
    } finally {
      setBusyId('');
    }
  };

  return (
    <div className="min-h-screen bg-neutral-50">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
        <Link to="/admin" className="inline-flex items-center gap-2 text-sm text-neutral-500 hover:text-neutral-900 mb-5"><ArrowLeft className="w-4 h-4" /> Back to admin dashboard</Link>
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 mb-8">
          <div>
            <p className="text-xs font-semibold tracking-wide text-neutral-500 mb-2">MARKETPLACE ADMIN</p>
            <h1 className="text-3xl font-bold text-neutral-900">Seller applications</h1>
            <p className="text-sm text-neutral-600 mt-2">Review applicants before enabling their seller accounts.</p>
          </div>
          <div className="flex flex-wrap gap-2"><Link to="/admin/seller-products"><Button variant="secondary"><ClipboardCheck className="w-4 h-4 mr-2" /> Product moderation</Button></Link><Link to="/admin/marketplace-controls"><Button variant="outline"><Store className="w-4 h-4 mr-2" /> Marketplace controls</Button></Link><Link to="/admin/marketplace-reports"><Button variant="outline"><ShieldCheck className="w-4 h-4 mr-2" /> Listing reports</Button></Link><Button variant="outline" onClick={load} loading={loading}><RefreshCw className="w-4 h-4 mr-2" /> Refresh</Button></div>
        </div>

        <Card className="p-4 mb-6">
          <div className="flex flex-col sm:flex-row sm:items-center gap-3">
            <label htmlFor="seller-status-filter" className="text-sm font-medium text-neutral-700">Application status</label>
            <select id="seller-status-filter" value={status} onChange={e => setStatus(e.target.value)} className="w-full sm:w-64 px-3 py-2.5 border border-neutral-300 rounded-lg bg-white text-sm">
              {filters.map(filter => <option key={filter.value} value={filter.value}>{filter.label}</option>)}
            </select>
            <span className="text-sm text-neutral-500 sm:ml-auto">{applications.length} shown (maximum 100)</span>
          </div>
        </Card>

        {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 mb-4">{error}</div>}
        {notice && <div role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700 mb-4">{notice}</div>}

        {loading ? (
          <Card className="p-8 text-center text-sm text-neutral-500">Loading seller applications…</Card>
        ) : applications.length === 0 ? (
          <Card><EmptyState title="No applications found" description={status === 'PENDING' ? 'New seller applications will appear here for review.' : 'Try another status filter to find seller applications.'} /></Card>
        ) : (
          <div className="space-y-4">
            {applications.map(application => {
              const badge = getStatusBadge(application.status);
              const busy = busyId === application.applicantUid;
              return (
                <Card key={application.id} className="p-5 sm:p-6">
                  <div className="flex flex-col lg:flex-row lg:items-start lg:justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <div className="flex flex-wrap items-center gap-2">
                        <Store className="w-5 h-5 text-neutral-500" />
                        <h2 className="text-lg font-semibold text-neutral-900">{application.displayName}</h2>
                        <Badge variant={badge.variant}>{badge.label}</Badge>
                        {application.verificationBadge && <span className="inline-flex items-center gap-1 text-xs font-semibold text-blue-700"><BadgeCheck className="w-4 h-4 fill-blue-50" /> Verified business</span>}
                      </div>
                      {application.businessName && <p className="text-sm text-neutral-600 mt-1">{application.businessName}</p>}
                      <div className="text-sm text-neutral-600 mt-3 space-y-1">
                        <p>{application.applicantEmail || 'No email supplied'}</p>
                        <p>{application.phone}</p>
                        <p>Categories: {application.categories.join(', ') || 'Not specified'}</p>
                        {application.description && <p className="pt-2 whitespace-pre-wrap">{application.description}</p>}
                        <p className="text-xs text-neutral-400 pt-1">Submitted {application.createdAt ? formatDateTime(application.createdAt) : 'date unavailable'} · Applicant ID: {application.applicantUid}</p>
                      </div>
                    </div>
                    <div className="w-full lg:max-w-sm space-y-3">
                      <div className="rounded-lg border border-neutral-200 p-3 space-y-3">
                        <p className="text-sm font-semibold">Business profile details</p>
                        <Input label="Seller display name" value={(profileEdits[application.applicantUid] || { displayName: application.displayName, businessName: application.businessName }).displayName} onChange={e => setProfileEdits(current => ({ ...current, [application.applicantUid]: { ...(current[application.applicantUid] || { displayName: application.displayName, businessName: application.businessName }), displayName: e.target.value } }))} maxLength={60} />
                        <Input label="Business name" value={(profileEdits[application.applicantUid] || { displayName: application.displayName, businessName: application.businessName }).businessName} onChange={e => setProfileEdits(current => ({ ...current, [application.applicantUid]: { ...(current[application.applicantUid] || { displayName: application.displayName, businessName: application.businessName }), businessName: e.target.value } }))} maxLength={100} />
                        <Button size="sm" variant="outline" loading={busy} disabled={Boolean(busyId && !busy)} onClick={() => void saveBusinessProfile(application)}><Save className="w-4 h-4 mr-1.5" /> Save profile (admin override)</Button>
                      </div>
                      <Input label="Admin note / decision reason" value={reasons[application.applicantUid] ?? application.adminReason ?? ''} onChange={e => setReasons(current => ({ ...current, [application.applicantUid]: e.target.value }))} placeholder="Add context for the applicant" maxLength={500} />
                      <div className="flex flex-wrap gap-2">
                        {application.status === 'PENDING' && <>
                          <Button size="sm" loading={busy} disabled={Boolean(busyId && !busy)} onClick={() => updateApplication(application, 'APPROVED')}><ShieldCheck className="w-4 h-4 mr-1.5" /> Approve</Button>
                          <Button size="sm" variant="danger" loading={busy} disabled={Boolean(busyId && !busy)} onClick={() => updateApplication(application, 'REJECTED')}>Reject</Button>
                        </>}
                        {application.status === 'APPROVED' && <>
                          <Button size="sm" variant="outline" loading={busy} disabled={Boolean(busyId && !busy)} onClick={() => void toggleVerification(application)}><BadgeCheck className="w-4 h-4 mr-1.5 text-blue-600" />{application.verificationBadge ? 'Remove verified badge' : 'Verify business'}</Button>
                          <Button size="sm" variant="danger" loading={busy} disabled={Boolean(busyId && !busy)} onClick={() => updateApplication(application, 'SUSPENDED')}>Suspend seller</Button>
                        </>}
                        {application.status === 'SUSPENDED' && <Button size="sm" variant="secondary" loading={busy} disabled={Boolean(busyId && !busy)} onClick={() => updateApplication(application, 'REINSTATED')}>Reinstate seller</Button>}
                      </div>
                    </div>
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
