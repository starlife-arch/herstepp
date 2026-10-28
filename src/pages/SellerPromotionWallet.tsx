import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, RefreshCw } from 'lucide-react';
import { Button, Card } from '../components/ui';
import { apiFetch } from '../lib/api';
import { usePageMeta } from '../hooks/usePageMeta';

const stamp = (v: any) => { const d = v ? new Date(v) : null; return d && Number.isFinite(d.getTime()) ? d.toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' }) : 'Time not recorded'; };
const campaignStatus = (x: any) => x.promotedUntil && new Date(x.promotedUntil).getTime() <= Date.now() ? 'INACTIVE' : String(x.status || 'ACTIVE').toUpperCase();
const money = (n: number) => new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES', maximumFractionDigits: 0 }).format(n || 0);
export default function SellerPromotionWallet() {
  usePageMeta('Promotion Wallet | HerStep Collection', 'Top up and manage seller product promotions.');
  const [data, setData] = useState<any>({ wallet: {}, products: [], pricing: [], ledger: [], campaigns: [] });
  const [rewardInfo, setRewardInfo] = useState<any>(null);
  const [rewardPoints, setRewardPoints] = useState('1000');
  const [rewardBusy, setRewardBusy] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [amount, setAmount] = useState('500');
  const [phone, setPhone] = useState('');
  const [payment, setPayment] = useState<any>(null);
  const [topUpBusy, setTopUpBusy] = useState(false);
  const [checkPaymentBusy, setCheckPaymentBusy] = useState(false);
  const [promoteBusy, setPromoteBusy] = useState(false);
  const [renewingCampaignId, setRenewingCampaignId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  async function load() { setData(await apiFetch('/api/sellers/promotion-wallet')); }
  useEffect(() => { load().catch((e: any) => setError(e.message || 'Could not load wallet.')); apiFetch('/api/rewards/account').then(setRewardInfo).catch(() => setRewardInfo(null)); }, []);
  const price = (data.pricing || []).find((p: any) => p.count === selected.length)?.amount ?? (selected.length ? selected.length * (selected.length === 1 ? 100 : selected.length <= 5 ? 95 : selected.length <= 10 ? 90 : selected.length <= 20 ? 85 : selected.length <= 30 ? 80 : selected.length <= 50 ? 75 : 70) : 0);
  async function topUp() {
    setTopUpBusy(true); setError(''); setNotice('');
    try { const r: any = await apiFetch('/api/sellers/promotion-wallet', { method: 'POST', body: JSON.stringify({ action: 'TOP_UP', amount: Number(amount), phone, idempotencyKey: 'wallet-' + crypto.randomUUID() }) }); setPayment(r.payment); setNotice('Approve the M-Pesa prompt, then check payment status.'); }
    catch (e: any) { setError(e.message || 'Could not start top-up.'); } finally { setTopUpBusy(false); }
  }
  async function checkPayment() {
    if (!payment?.id) return; setCheckPaymentBusy(true); setError('');
    try { const r: any = await apiFetch('/api/sellers/promotion-wallet?paymentId=' + encodeURIComponent(payment.id)); setPayment(r.payment); if (r.payment?.status === 'PAID') { setNotice('Payment verified and added to your wallet.'); await load(); } else setNotice('Payment status: ' + r.payment?.status); }
    catch (e: any) { setError(e.message || 'Could not verify payment.'); } finally { setCheckPaymentBusy(false); }
  }
  async function redeemRewardsToWallet() {
    const points = Number(rewardPoints);
    if (!Number.isSafeInteger(points) || points < 100) { setError('Enter at least 100 whole reward points.'); return; }
    setRewardBusy(true); setError(''); setNotice('');
    try {
      const r: any = await apiFetch('/api/sellers/promotion-wallet', { method: 'POST', body: JSON.stringify({ action: 'REDEEM_REWARDS', points, idempotencyKey: 'promo-reward-' + crypto.randomUUID() }) });
      setNotice(r.message + ' Added ' + money(r.amountAdded || 0) + ' to your promotion wallet.');
      const [walletData, rewardsData]: any[] = await Promise.all([apiFetch('/api/sellers/promotion-wallet'), apiFetch('/api/rewards/account')]);
      setData(walletData); setRewardInfo(rewardsData);
    } catch (e: any) { setError(e.message || 'Could not redeem reward points.'); }
    finally { setRewardBusy(false); }
  }
  async function promote() {
    if (!selected.length) return; setPromoteBusy(true); setError(''); setNotice('');
    try { const r: any = await apiFetch('/api/sellers/promotion-wallet', { method: 'POST', body: JSON.stringify({ action: 'PROMOTE', productIds: selected }) }); setNotice(r.productCount + ' products promoted for ' + r.durationDays + ' days. Charged ' + money(r.amount) + '.'); setSelected([]); await load(); }
    catch (e: any) { setError(e.message || 'Promotion failed.'); } finally { setPromoteBusy(false); }
  }
  async function renewCampaign(campaign: any) {
    const ids = Array.isArray(campaign.productIds) ? [...new Set(campaign.productIds)] : [];
    if (!ids.length) { setError('This campaign has no product list to renew.'); return; }
    setRenewingCampaignId(campaign.id); setError(''); setNotice('');
    try {
      const r: any = await apiFetch('/api/sellers/promotion-wallet', { method: 'POST', body: JSON.stringify({ action: 'PROMOTE', productIds: ids }) });
      setNotice('Campaign renewed for ' + r.durationDays + ' days. Charged ' + money(r.amount) + ' from your promotion wallet.');
      await load();
    } catch (e: any) { setError(e.message || 'Could not renew this campaign. Check your wallet balance.'); }
    finally { setRenewingCampaignId(null); }
  }
  return <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8">
    <Link to="/seller/dashboard" className="inline-flex items-center gap-2 text-sm mb-5"><ArrowLeft className="w-4 h-4" /> Seller dashboard</Link>
    <h1 className="text-3xl font-bold">Promotion wallet</h1><p className="text-neutral-600 mt-2 mb-6">Top up once and promote one or more active products. This money is separate from your sales earnings.</p>
    {error && <p role="alert" className="p-3 mb-3 rounded bg-red-50 text-red-700">{error}</p>}{notice && <p role="status" className="p-3 mb-3 rounded bg-emerald-50 text-emerald-800">{notice}</p>}
    <div className="grid gap-3 sm:grid-cols-3 mb-5"><Card className="p-4"><p className="text-sm text-neutral-500">Available balance</p><p className="text-2xl font-bold">{money(data.wallet?.availableBalance)}</p></Card><Card className="p-4"><p className="text-sm text-neutral-500">Total top-ups</p><p className="text-2xl font-bold">{money(data.wallet?.totalDeposited)}</p></Card><Card className="p-4"><p className="text-sm text-neutral-500">Total spent</p><p className="text-2xl font-bold">{money(data.wallet?.totalSpent)}</p></Card></div>
    <div className="grid gap-5 lg:grid-cols-2"><Card className="p-5"><h2 className="font-semibold text-lg">Use reward points</h2><p className="text-sm text-neutral-600 mt-1">Convert eligible seller reward points into promotion-wallet funds. 100 points = KSh 10 at the standard conversion rate.</p><p className="text-sm mt-2">Available points: <strong>{Number(rewardInfo?.pointsBalance || 0).toLocaleString()}</strong></p>{rewardInfo?.redemptionEnabled ? <><label className="block text-sm mt-3">Points to redeem<input type="number" min={Math.max(100, Number(rewardInfo.minRedeemPoints) || 100)} step="100" value={rewardPoints} onChange={e => setRewardPoints(e.target.value)} className="block w-full border rounded p-2 mt-1" /></label><p className="text-xs text-neutral-500 mt-1">Wallet credit: {money(Number(rewardPoints) * (Number(rewardInfo?.pointValueKes) || 0.1))}</p><Button className="mt-3" onClick={redeemRewardsToWallet} disabled={rewardBusy || Number(rewardPoints) > Number(rewardInfo?.pointsBalance || 0) || Number(rewardPoints) < Math.max(100, Number(rewardInfo?.minRedeemPoints) || 100) || Number(rewardPoints) % 100 !== 0}>{rewardBusy ? "Redeeming…" : "Convert points to wallet funds"}</Button></> : <p className="text-sm text-neutral-500 mt-3">Reward redemption is not enabled for seller promotions.</p>}</Card><Card className="p-5"><h2 className="font-semibold text-lg">Top up with M-Pesa</h2><label className="block text-sm mt-3">Amount in KSh<input type="number" min="100" max="1000000" value={amount} onChange={e => setAmount(e.target.value)} className="block w-full border rounded p-2 mt-1" /></label><label className="block text-sm mt-3">M-Pesa phone<input value={phone} onChange={e => setPhone(e.target.value)} placeholder="07… or 2547…" className="block w-full border rounded p-2 mt-1" /></label><Button className="mt-3" onClick={topUp} disabled={topUpBusy}>{topUpBusy ? "Sending prompt…" : "Send top-up prompt"}</Button>{payment && <div className="mt-3 text-sm">Payment status: <strong>{payment.status}</strong><div><Button variant="outline" size="sm" onClick={checkPayment} disabled={checkPaymentBusy}><RefreshCw className="w-4 h-4 mr-2" /> {checkPaymentBusy ? "Checking…" : "Check status"}</Button></div></div>}</Card>
    <Card className="p-5"><h2 className="font-semibold text-lg">Promote products</h2><p className="text-sm text-neutral-600 mt-1">Campaigns last 7 days. Select active listings you own.</p><div className="mt-3 max-h-72 overflow-auto space-y-2">{(data.products || []).map((p: any) => <label key={p.id} className="flex gap-2 border rounded p-3 text-sm"><input type="checkbox" checked={selected.includes(p.id)} onChange={e => setSelected(old => e.target.checked ? [...old, p.id] : old.filter(id => id !== p.id))} /><span>{p.name}{p.promotedUntil ? ' — currently promoted' : ''}</span></label>)}{!data.products?.length && <p className="text-sm text-neutral-500">No active products to promote.</p>}</div><p className="mt-3 text-sm">Selected: {selected.length} · Price: <strong>{money(price)}</strong></p><Button className="mt-3" onClick={promote} disabled={promoteBusy || !selected.length}>{promoteBusy ? "Promoting…" : "Promote selected products"}</Button><div className="mt-4 grid grid-cols-2 gap-2">{(data.pricing || []).map((p: any) => <div key={p.count} className="border rounded p-2 text-xs">{p.count} products: <strong>{money(p.amount)}</strong></div>)}</div></Card></div>
    <Card className="p-5 mt-5"><h2 className="font-semibold text-lg">Wallet history</h2>{(data.ledger || []).slice(0, 20).map((x: any) => <div key={x.id} className="border-b py-2 flex justify-between text-sm"><span>{String(x.type).replace(/_/g, ' ')}<small className="block text-xs text-neutral-500">{stamp(x.createdAt)}</small></span><strong>{Number(x.balanceDelta) < 0 ? '−' : '+'}{money(Math.abs(Number(x.balanceDelta) || 0))}</strong></div>)}{!data.ledger?.length && <p className="text-sm text-neutral-500 mt-2">No transactions yet.</p>}<h3 className="font-semibold mt-5">Campaign history</h3>{(data.campaigns || []).slice(0, 20).map((x: any) => <div key={x.id} className="border-b py-2 flex justify-between text-sm"><span>{x.productCount} products · {campaignStatus(x)}<small className="block text-xs text-neutral-500">Started: {stamp(x.createdAt)} · Expires: {stamp(x.promotedUntil)}</small>{campaignStatus(x) === 'INACTIVE' && <Button size="sm" variant="outline" className="mt-2" onClick={() => void renewCampaign(x)} disabled={renewingCampaignId === x.id}>{renewingCampaignId === x.id ? 'Renewing…' : 'Renew campaign'}</Button>}</span><strong>{money(x.amount)}</strong></div>)}</Card>
  </div>;
}
