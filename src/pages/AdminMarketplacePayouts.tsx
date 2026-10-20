import React, { useEffect, useState } from 'react';
import { RefreshCw, Wallet, CheckCircle2, XCircle, Banknote } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { usePageMeta } from '../hooks/usePageMeta';
import { Card, Button } from '../components/ui';

const money = (value: unknown) => new Intl.NumberFormat('en-KE', { style: 'currency', currency: 'KES', maximumFractionDigits: 0 }).format(Number(value) || 0);
type Payout = { id: string; sellerId: string; amount: number; currency: string; status: string; sellerName?: string; payoutPhone?: string; payoutPhoneMasked?: string; reason?: string; providerReference?: string; requestedAt?: string; };
type SellerLine = { sellerId: string; sellerName: string; productName: string; lineTotal: number; itemIndex: number; };
type Refund = { id: string; orderDocumentId: string; orderId: string; amount: number; currency: string; reason?: string; providerReference?: string; sellerLines: SellerLine[]; };
const uniqueSellers = (refund: Refund) => Array.from(new Map<string, SellerLine>(refund.sellerLines.map(line => [line.sellerId, line] as [string, SellerLine])).values());
export default function AdminMarketplacePayouts() {
  usePageMeta('Marketplace Payouts | HerStep Admin', 'Review and reconcile marketplace seller payouts.');
  const [payouts, setPayouts] = useState<Payout[]>([]);
  const [refunds, setRefunds] = useState<Refund[]>([]);
  const [allocations, setAllocations] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [notes, setNotes] = useState<Record<string, string>>({});
  const [references, setReferences] = useState<Record<string, string>>({});
  async function refresh() {
    setLoading(true); setError('');
    try { const result: any = await apiFetch('/api/admin/marketplace-payouts'); setPayouts(Array.isArray(result.payouts) ? result.payouts : []); setRefunds(Array.isArray(result.refundsToReconcile) ? result.refundsToReconcile : []); }
    catch (err: any) { setError(err?.message || 'Could not load payout requests.'); }
    finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, []);
  async function act(payout: Payout, action: 'APPROVE' | 'REJECT' | 'MARK_PAID') {
    if (action !== 'MARK_PAID' && !notes[payout.id]?.trim()) { setError('Enter a review note before approving or rejecting.'); return; }
    if (action === 'MARK_PAID' && !references[payout.id]?.trim()) { setError('Enter the confirmed M-Pesa/provider reference after sending the money.'); return; }
    setBusy(payout.id); setError(''); setNotice('');
    try {
      const result: any = await apiFetch('/api/admin/marketplace-payouts', { method: 'POST', body: JSON.stringify({ payoutId: payout.id, action, reason: notes[payout.id]?.trim() || '', providerReference: references[payout.id]?.trim() || '' }) });
      setNotice(result.message || 'Payout updated.');
      await refresh();
    } catch (err: any) { setError(err?.message || 'Could not update this payout.'); }
    finally { setBusy(null); }
  }
  async function reconcile(refund: Refund) {
    const chosen = uniqueSellers(refund).map(seller => ({
      sellerId: seller.sellerId,
      amount: Number(allocations[`${refund.id}:${seller.sellerId}`] || 0),
    })).filter(row => Number.isSafeInteger(row.amount) && row.amount > 0);
    const total = chosen.reduce((sum, row) => sum + row.amount, 0);
    if (total > refund.amount) { setError('Seller allocations cannot exceed the confirmed refund amount.'); return; }
    if (!notes[refund.id]?.trim()) { setError('Enter a reconciliation note.'); return; }
    setBusy(refund.id); setError(''); setNotice('');
    try {
      const result: any = await apiFetch('/api/admin/marketplace-payouts', { method: 'POST', body: JSON.stringify({
        action: 'RECONCILE_REFUND', refundRecordId: refund.id, allocations: chosen, reason: notes[refund.id].trim(),
      }) });
      setNotice(result.message || 'Refund reconciled.');
      await refresh();
    } catch (err: any) { setError(err?.message || 'Could not reconcile this refund.'); }
    finally { setBusy(null); }
  }
  return <div className="max-w-6xl mx-auto px-4 sm:px-6 py-10">
    <div className="flex flex-wrap items-center justify-between gap-3 mb-6"><div><p className="text-xs font-semibold tracking-wide text-neutral-500">HERSTEP MARKETPLACE</p><h1 className="text-3xl font-bold mt-1">Seller payouts</h1><p className="text-sm text-neutral-600 mt-2">Review seller requests and record confirmed payments. This page does not initiate transfers.</p></div><Button variant="outline" onClick={() => void refresh()} disabled={loading}><RefreshCw className="w-4 h-4 mr-2" /> Refresh</Button></div>
    {notice && <div role="status" className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm text-emerald-800 mb-4">{notice}</div>}
    {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 mb-4">{error}</div>}
    {refunds.length > 0 && <section className="mb-8 space-y-4">
      <div><h2 className="text-xl font-bold">Confirmed refunds awaiting marketplace reconciliation</h2><p className="text-sm text-neutral-600 mt-1">Allocate only the marketplace sellers’ share. Any HerStep first-party portion stays outside seller ledgers. Leave every allocation at zero when the confirmed refund contains no marketplace seller share; add a note explaining the allocation.</p></div>
      {refunds.map(refund => <Card key={refund.id} className="p-5">
        <div className="flex flex-wrap justify-between gap-3"><div><h3 className="font-semibold">Order {refund.orderId}</h3><p className="text-xs text-neutral-500">Refund record: {refund.id}</p><p className="text-sm mt-1">Provider reference: {refund.providerReference || 'Not provided'}</p></div><div className="text-right"><p className="text-xl font-bold">{money(refund.amount)}</p><p className="text-xs text-neutral-500">Confirmed refund total</p></div></div>
        <div className="mt-4 space-y-3">{uniqueSellers(refund).map(seller => <div key={seller.sellerId} className="grid grid-cols-1 sm:grid-cols-[1fr_180px] gap-2 items-center">
          <div><p className="font-medium text-sm">{seller.sellerName}</p><p className="text-xs text-neutral-500">{seller.sellerId} · Marketplace items: {money(refund.sellerLines.filter(line => line.sellerId === seller.sellerId).reduce((sum, line) => sum + line.lineTotal, 0))}</p></div>
          <label className="text-xs">Refund allocated (KSh)<input type="number" min="0" step="1" value={allocations[`${refund.id}:${seller.sellerId}`] || ''} onChange={e => setAllocations(prev => ({ ...prev, [`${refund.id}:${seller.sellerId}`]: e.target.value }))} className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm" placeholder="0 if none" /></label>
        </div>)}</div>
        <div className="mt-4"><label className="block text-xs font-medium mb-1">Reconciliation note<input value={notes[refund.id] || ''} onChange={e => setNotes(prev => ({ ...prev, [refund.id]: e.target.value }))} className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm" placeholder="Explain how the refund was allocated" /></label></div>
        <Button className="mt-3" disabled={busy === refund.id} onClick={() => void reconcile(refund)}>{busy === refund.id ? 'Reconciling…' : 'Reconcile seller refund'}</Button>
      </Card>)}
    </section>}
    {loading ? <Card className="p-8 text-center text-sm text-neutral-500">Loading payout requests…</Card> : payouts.length === 0 ? <Card className="p-8 text-center"><Wallet className="w-8 h-8 mx-auto text-neutral-400 mb-2" /><p className="font-medium">No payout requests yet</p></Card> : <div className="space-y-4">{payouts.map(payout => <Card key={payout.id} className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="font-semibold text-lg">{payout.sellerName || 'Marketplace seller'}</h2><p className="text-xs text-neutral-500 mt-1">Request: {payout.id}</p><p className="text-sm text-neutral-600 mt-1">Seller UID: {payout.sellerId} · M-Pesa destination: {payout.payoutPhone || payout.payoutPhoneMasked || 'Not available'}</p></div><div className="text-right"><p className="text-2xl font-bold">{money(payout.amount)}</p><p className="text-xs font-semibold mt-1">{payout.status}</p></div></div>
      {payout.providerReference && <p className="text-sm mt-3">Provider reference: <span className="font-mono">{payout.providerReference}</span></p>}
      {['REQUESTED','PENDING','APPROVED'].includes(String(payout.status || 'REQUESTED').toUpperCase()) && <div className="mt-4 grid gap-3">
        <div><label className="block text-xs font-medium mb-1" htmlFor={`payout-note-${payout.id}`}>Review note / reason</label><input id={`payout-note-${payout.id}`} value={notes[payout.id] || ''} onChange={e => setNotes(prev => ({ ...prev, [payout.id]: e.target.value }))} className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm" placeholder="Reason for approval or rejection" /></div>
        {String(payout.status || '').toUpperCase() === 'APPROVED' && <div><label className="block text-xs font-medium mb-1" htmlFor={`payout-ref-${payout.id}`}>Confirmed provider reference</label><input id={`payout-ref-${payout.id}`} value={references[payout.id] || ''} onChange={e => setReferences(prev => ({ ...prev, [payout.id]: e.target.value }))} className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm" placeholder="M-Pesa transaction reference after payment" /></div>}
        <div className="flex flex-wrap gap-2">{['REQUESTED','PENDING'].includes(String(payout.status || 'REQUESTED').toUpperCase()) && <><Button size="sm" disabled={busy === payout.id} onClick={() => void act(payout,'APPROVE')}><CheckCircle2 className="w-4 h-4 mr-1" /> Approve</Button><Button size="sm" variant="outline" disabled={busy === payout.id} onClick={() => void act(payout,'REJECT')}><XCircle className="w-4 h-4 mr-1" /> Reject</Button></>}{String(payout.status || '').toUpperCase() === 'APPROVED' && <Button size="sm" disabled={busy === payout.id} onClick={() => void act(payout,'MARK_PAID')}><Banknote className="w-4 h-4 mr-1" /> Record as paid</Button>}</div>
      </div>}
    </Card>)}</div>}
  </div>;
}
