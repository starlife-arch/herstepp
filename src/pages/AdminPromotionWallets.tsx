import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { Button, Card } from '../components/ui';
import { apiFetch } from '../lib/api';
import { usePageMeta } from '../hooks/usePageMeta';
const money = (n: number) => new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES', maximumFractionDigits: 0 }).format(n || 0);
export default function AdminPromotionWallets() {
  usePageMeta('Promotion Wallet Reports | HerStep Operations', 'Advertising wallet balances and campaign activity.');
  const [data, setData] = useState<any>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  async function load() { setLoading(true); setError(''); try { setData(await apiFetch('/api/admin/promotion-wallets')); } catch (e: any) { setError(e.message || 'Could not load promotion reports.'); } finally { setLoading(false); } }
  useEffect(() => { load(); }, []);
  const summary = data?.summary || {};
  return <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
    <Link to="/admin" className="inline-flex items-center gap-2 text-sm mb-5"><ArrowLeft className="w-4 h-4" /> Platform Operations</Link>
    <div className="flex flex-wrap justify-between gap-3 mb-6"><div><p className="text-xs font-semibold tracking-wide text-neutral-500 mb-2">MARKETPLACE OPERATIONS</p><h1 className="text-3xl font-bold">Promotion wallet reports</h1><p className="text-neutral-600 mt-2">Advertising balances are separate from sellers' sales earnings.</p></div><Button variant="outline" onClick={load} loading={loading}><RefreshCw className="w-4 h-4 mr-2" /> Refresh</Button></div>
    {error && <p role="alert" className="p-3 rounded bg-red-50 text-red-700 mb-4">{error}</p>}
    <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3 mb-6">{[['Available wallet balances',summary.totalAvailableBalance],['Verified top-ups',summary.totalDeposited],['Advertising spend',summary.totalAdvertisingSpend]].map(([label,value]: any) => <Card key={label} className="p-4"><p className="text-sm text-neutral-500">{label}</p><p className="text-2xl font-bold mt-2">{money(Number(value))}</p></Card>)}<Card className="p-4"><p className="text-sm text-neutral-500">Active campaigns</p><p className="text-2xl font-bold mt-2">{summary.activeCampaigns || 0}</p></Card><Card className="p-4"><p className="text-sm text-neutral-500">Campaigns recorded</p><p className="text-2xl font-bold mt-2">{summary.campaigns || 0}</p></Card><Card className="p-4"><p className="text-sm text-neutral-500">Sellers with wallets</p><p className="text-2xl font-bold mt-2">{summary.sellersWithWallets || 0}</p></Card></div>
    <Card className="p-5 mb-6"><h2 className="font-semibold text-lg">Seller wallet balances</h2><div className="overflow-x-auto mt-3"><table className="w-full text-sm text-left"><thead><tr className="border-b text-neutral-500"><th className="py-2 pr-4">Seller</th><th className="py-2 pr-4">Available</th><th className="py-2 pr-4">Top-ups</th><th className="py-2 pr-4">Spent</th></tr></thead><tbody>{(data?.wallets || []).map((w: any) => <tr key={w.sellerUid} className="border-b"><td className="py-3 pr-4"><span className="font-medium">{w.sellerName}</span><span className="block text-xs text-neutral-500">{w.sellerUid}</span></td><td className="py-3 pr-4">{money(w.availableBalance)}</td><td className="py-3 pr-4">{money(w.totalDeposited)}</td><td className="py-3 pr-4">{money(w.totalSpent)}</td></tr>)}{!loading && !(data?.wallets || []).length && <tr><td colSpan={4} className="py-4 text-neutral-500">No promotion wallets recorded yet.</td></tr>}</tbody></table></div></Card>
    <Card className="p-5"><h2 className="font-semibold text-lg">Recent advertising transactions</h2><div className="mt-3 divide-y">{(data?.recentTransactions || []).slice(0,50).map((x: any) => <div key={x.id} className="py-3 flex flex-wrap justify-between gap-2 text-sm"><span>{String(x.type || 'TRANSACTION').replace(/_/g,' ')} · {x.sellerUid}</span><strong>{Number(x.balanceDelta) < 0 ? '−' : '+'}{money(Math.abs(Number(x.balanceDelta) || 0))}</strong></div>)}{!loading && !(data?.recentTransactions || []).length && <p className="py-3 text-sm text-neutral-500">No advertising transactions yet.</p>}</div></Card>
  </div>;
}
