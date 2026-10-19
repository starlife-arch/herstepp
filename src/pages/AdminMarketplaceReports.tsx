import React, { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, RefreshCw, ShieldCheck } from 'lucide-react';
import { Badge, Button, Card, EmptyState } from '../components/ui';
import { apiFetch } from '../lib/api';
import { usePageMeta } from '../hooks/usePageMeta';

type Report = {
  id: string;
  productId: string;
  productName: string;
  sellerUid: string;
  sellerDisplayName?: string;
  reporterUid: string;
  reasonCode: string;
  details?: string;
  status: 'OPEN' | 'UNDER_REVIEW' | 'RESOLVED' | 'DISMISSED';
  adminNote?: string;
  createdAt?: string;
};

const reasons: Record<string, string> = {
  COUNTERFEIT_OR_MISLEADING: 'Counterfeit or misleading',
  SUSPICIOUS_SELLER: 'Suspicious seller',
  PROHIBITED_ITEM: 'Prohibited item',
  WRONG_INFORMATION: 'Incorrect listing information',
  OTHER: 'Other',
};
const dateLabel = (value?: string) => {
  if (!value) return 'Date unavailable';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Date unavailable' : date.toLocaleString('en-KE');
};

export default function AdminMarketplaceReports() {
  usePageMeta('Marketplace Reports | HerStep Admin', 'Review reports about marketplace seller listings.');
  const [reports, setReports] = useState<Report[]>([]);
  const [status, setStatus] = useState('OPEN');
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');

  const load = useCallback(async () => {
    setLoading(true); setError(''); setNotice('');
    try {
      const result: any = await apiFetch(`/api/admin/marketplace-reports?status=${encodeURIComponent(status)}`);
      setReports(Array.isArray(result.reports) ? result.reports : []);
    } catch (err: any) {
      setError(err?.message || 'Could not load marketplace reports.');
    } finally { setLoading(false); }
  }, [status]);

  useEffect(() => { void load(); }, [load]);

  async function updateReport(report: Report, nextStatus: Report['status']) {
    const adminNote = (notes[report.id] || '').trim();
    if (nextStatus === 'DISMISSED' && adminNote.length < 3) {
      setError('Add a short reason before dismissing a report.');
      return;
    }
    setBusyId(report.id); setError(''); setNotice('');
    try {
      await apiFetch('/api/admin/marketplace-reports', {
        method: 'PATCH',
        body: JSON.stringify({ id: report.id, status: nextStatus, adminNote }),
      });
      setNotice(`Report updated to ${nextStatus.replace('_', ' ').toLowerCase()}.`);
      await load();
    } catch (err: any) {
      setError(err?.message || 'Could not update this report.');
    } finally { setBusyId(''); }
  }

  return <div className="max-w-6xl mx-auto px-4 sm:px-6 py-10">
    <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-4 mb-7">
      <div><p className="text-xs font-semibold tracking-wide text-neutral-500 mb-2">HERSTEP MARKETPLACE</p><h1 className="text-3xl font-bold text-neutral-900">Listing reports</h1><p className="text-neutral-600 mt-2">Review customer reports and record an auditable outcome. Reporting does not automatically remove a listing.</p></div>
      <Button variant="outline" onClick={() => void load()} disabled={loading}><RefreshCw className="w-4 h-4 mr-2" /> Refresh</Button>
    </div>
    <div className="flex flex-wrap gap-2 mb-6">
      {['OPEN', 'UNDER_REVIEW', 'RESOLVED', 'DISMISSED', 'ALL'].map(value => <button key={value} onClick={() => setStatus(value)} className={`rounded-full border px-4 py-2 text-sm ${status === value ? 'bg-neutral-900 text-white border-neutral-900' : 'bg-white text-neutral-700 border-neutral-300'}`}>{value.replace('_', ' ')}</button>)}
    </div>
    {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 text-red-800 px-4 py-3 text-sm mb-4">{error}</div>}
    {notice && <div role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-800 px-4 py-3 text-sm mb-4">{notice}</div>}
    {loading ? <Card className="p-8 text-center text-sm text-neutral-500">Loading reports…</Card> : reports.length === 0 ? <EmptyState title="No reports found" description="Reports matching this status will appear here." /> : <div className="space-y-4">
      {reports.map(report => <Card key={report.id} className="p-5 sm:p-6">
        <div className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
          <div className="flex gap-3"><div className="rounded-xl bg-amber-50 p-3 self-start"><AlertTriangle className="w-5 h-5 text-amber-700" /></div><div><h2 className="font-semibold text-neutral-900">{report.productName || 'Marketplace listing'}</h2><p className="text-sm text-neutral-500 mt-1">Reported {dateLabel(report.createdAt)}</p><p className="text-sm text-neutral-600 mt-2">Seller: {report.sellerDisplayName || report.sellerUid}</p><p className="text-sm text-neutral-600">Product ID: <span className="font-mono">{report.productId}</span></p><p className="text-sm text-neutral-600">Reporter ID: <span className="font-mono">{report.reporterUid}</span></p></div></div>
          <Badge variant={report.status === 'OPEN' ? 'warning' : report.status === 'RESOLVED' ? 'success' : report.status === 'DISMISSED' ? 'danger' : 'default'}>{report.status.replace('_', ' ')}</Badge>
        </div>
        <div className="mt-4 rounded-lg bg-neutral-50 p-4"><p className="text-sm font-semibold text-neutral-800">{reasons[report.reasonCode] || report.reasonCode}</p>{report.details && <p className="text-sm text-neutral-700 mt-2 whitespace-pre-line">{report.details}</p>}</div>
        {report.adminNote && <p className="text-sm text-neutral-600 mt-3">Previous review note: {report.adminNote}</p>}
        <label className="block text-sm font-medium text-neutral-800 mt-4 mb-2" htmlFor={`note-${report.id}`}>Admin note {report.status === 'DISMISSED' ? '(required to dismiss)' : '(optional)'}</label>
        <textarea id={`note-${report.id}`} value={notes[report.id] ?? report.adminNote ?? ''} onChange={event => setNotes(current => ({ ...current, [report.id]: event.target.value }))} rows={2} maxLength={1000} className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm" placeholder="Record the action taken or reason for dismissal…" />
        <div className="flex flex-wrap gap-2 mt-3">
          {report.status === 'OPEN' && <Button variant="outline" disabled={busyId === report.id} onClick={() => void updateReport(report, 'UNDER_REVIEW')}><ShieldCheck className="w-4 h-4 mr-2" /> Mark under review</Button>}
          {report.status !== 'RESOLVED' && <Button disabled={busyId === report.id} onClick={() => void updateReport(report, 'RESOLVED')}>Resolve report</Button>}
          {report.status !== 'DISMISSED' && <Button variant="outline" disabled={busyId === report.id} onClick={() => void updateReport(report, 'DISMISSED')}>Dismiss report</Button>}
        </div>
      </Card>)}
    </div>}
  </div>;
}
