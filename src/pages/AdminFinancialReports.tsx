import React, { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, RefreshCw, FileBarChart2, Sparkles, AlertTriangle } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { usePageMeta } from '../hooks/usePageMeta';
import { Button, Card, formatCurrency } from '../components/ui';

type Report = {
  period: string; from: string; to: string; currency: string;
  totals: { grossRevenue: number; confirmedRefunds: number; recordedProviderFees: number; netRevenue: number; transactionCount: number; refundCount: number; providerFeeRecordedCount: number; providerFeeMissingCount: number };
  byCategory: Array<{ category: string; total: number; count: number }>;
  transactions: Array<{ id: string; category: string; description: string; date: string; amount: number; provider: string; providerFee: number | null; reference: string }>;
  dataQuality: { note: string; perCollectionReadLimit: number };
  aiExplanation: string;
};
const money = (value: number) => formatCurrency(Number(value) || 0);
const dateLabel = (value: string) => { const d = new Date(value); return Number.isNaN(d.getTime()) ? '—' : d.toLocaleString('en-KE'); };

export default function AdminFinancialReports() {
  usePageMeta('AI Financial Reports | HerStep Operations', 'Verified transaction-based financial reporting.');
  const [period, setPeriod] = useState('month');
  const [from, setFrom] = useState(new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' }));
  const [to, setTo] = useState(new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' }));
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    setLoading(true); setError('');
    try {
      const params = new URLSearchParams({ period, ...(period === 'custom' ? { from, to } : {}) });
      const result = await apiFetch('/api/admin/financial-reports?' + params.toString());
      setReport(result as Report);
    } catch (e: any) { setError(e?.message || 'Could not load financial reports.'); setReport(null); }
    finally { setLoading(false); }
  }, [period, from, to]);
  useEffect(() => { void load(); }, [load]);
  const totals = report?.totals;
  return <div className="mx-auto max-w-7xl space-y-6 px-4 py-8 sm:px-6">
    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
      <div><Link to="/admin" className="mb-3 inline-flex items-center gap-2 text-sm text-neutral-500 hover:text-neutral-900"><ArrowLeft className="h-4 w-4" /> Operations dashboard</Link><div className="flex items-center gap-3"><FileBarChart2 className="h-7 w-7 text-neutral-800" /><div><h1 className="text-2xl font-bold text-neutral-900">AI Financial Reports</h1><p className="mt-1 text-sm text-neutral-500">Revenue and refunds from verified payment and accounting records.</p></div></div></div>
      <Button variant="outline" onClick={() => void load()} disabled={loading}><RefreshCw className={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} /> Refresh</Button>
    </div>
    <Card className="p-4"><div className="flex flex-wrap items-end gap-3"><div><label className="mb-1 block text-sm font-medium">Reporting period</label><select value={period} onChange={e => setPeriod(e.target.value)} className="rounded-lg border border-neutral-300 px-3 py-2.5"><option value="day">Today</option><option value="month">This month</option><option value="year">This year</option><option value="custom">Custom dates</option></select></div>{period === 'custom' && <><div><label className="mb-1 block text-sm font-medium">From</label><input type="date" value={from} onChange={e => setFrom(e.target.value)} className="rounded-lg border border-neutral-300 px-3 py-2.5" /></div><div><label className="mb-1 block text-sm font-medium">To</label><input type="date" value={to} onChange={e => setTo(e.target.value)} className="rounded-lg border border-neutral-300 px-3 py-2.5" /></div></>}<p className="pb-2 text-xs text-neutral-500">Amounts shown in Kenyan shillings (KSh).</p></div></Card>
    {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error}</div>}
    {loading && !report ? <Card className="p-8 text-center text-sm text-neutral-500">Loading verified accounting records…</Card> : report && <>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">{[
        ['Gross revenue', totals!.grossRevenue, 'Before refunds and provider fees'],
        ['Confirmed refunds', totals!.confirmedRefunds, `${totals!.refundCount} confirmed records`],
        ['Recorded provider fees', totals!.recordedProviderFees, `${totals!.providerFeeRecordedCount} records with fee data`],
        ['Net revenue', totals!.netRevenue, 'After recorded refunds and fees']
      ].map(([label, value, hint]) => <Card key={String(label)} className="p-5"><p className="text-sm text-neutral-500">{label}</p><p className="mt-2 text-2xl font-bold text-neutral-900">{money(Number(value))}</p><p className="mt-1 text-xs text-neutral-500">{hint}</p></Card>)}</div>
      {totals!.providerFeeMissingCount > 0 && <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900"><AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" /><div><strong>Net revenue is provisional.</strong> Provider fees are not recorded for {totals!.providerFeeMissingCount} revenue records. Those fees are not guessed or estimated.</div></div>}
      <Card className="p-5"><div className="flex items-center gap-2"><Sparkles className="h-5 w-5" /><h2 className="font-semibold">AI explanation</h2></div><p className="mt-3 text-sm leading-6 text-neutral-700">{report.aiExplanation}</p><p className="mt-3 text-xs text-neutral-500">This explanation is generated from the totals above; it does not generate or estimate financial figures.</p></Card>
      <Card className="p-5"><h2 className="font-semibold">Revenue by source</h2>{report.byCategory.length ? <div className="mt-3 divide-y divide-neutral-100">{report.byCategory.map(row => <div key={row.category} className="flex flex-wrap items-center justify-between gap-2 py-3"><div><p className="font-medium text-neutral-800">{row.category}</p><p className="text-xs text-neutral-500">{row.count} records</p></div><p className="font-semibold">{money(row.total)}</p></div>)}</div> : <p className="mt-3 text-sm text-neutral-500">No qualifying revenue records were found for this period.</p>}</Card>
      <Card className="overflow-hidden"><div className="border-b border-neutral-200 p-5"><h2 className="font-semibold">Revenue transactions</h2><p className="mt-1 text-xs text-neutral-500">Up to 500 recent qualifying records. Seller wallet top-ups are not counted as revenue until spent on promotions.</p></div>{report.transactions.length ? <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead className="bg-neutral-50 text-xs uppercase text-neutral-500"><tr><th className="px-4 py-3">Date</th><th className="px-4 py-3">Source</th><th className="px-4 py-3">Reference</th><th className="px-4 py-3">Provider</th><th className="px-4 py-3 text-right">Revenue</th><th className="px-4 py-3 text-right">Provider fee</th></tr></thead><tbody className="divide-y divide-neutral-100">{report.transactions.map(row => <tr key={row.category + row.id}><td className="whitespace-nowrap px-4 py-3">{dateLabel(row.date)}</td><td className="px-4 py-3">{row.category}<p className="text-xs text-neutral-500">{row.description}</p></td><td className="px-4 py-3 font-mono text-xs">{row.reference}</td><td className="px-4 py-3">{row.provider}</td><td className="px-4 py-3 text-right font-medium">{money(row.amount)}</td><td className="px-4 py-3 text-right">{row.providerFee == null ? 'Not recorded' : money(row.providerFee)}</td></tr>)}</tbody></table></div> : <p className="p-6 text-sm text-neutral-500">No qualifying transactions for this period.</p>}</Card>
      <Card className="p-4"><p className="text-sm font-medium">Accounting coverage note</p><p className="mt-1 text-xs leading-5 text-neutral-500">{report.dataQuality.note}</p></Card>
    </>}
  </div>;
}
