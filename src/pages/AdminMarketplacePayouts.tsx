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
  const [printPayBalance, setPrintPayBalance] = useState<{ walletId?: string; balance: number; currency?: string } | null>(null);
  const [balanceLoading, setBalanceLoading] = useState(false);
  const [topupPhone, setTopupPhone] = useState('');
  const [topupAmount, setTopupAmount] = useState('10');
  const [topupLoading, setTopupLoading] = useState(false);
  const [topupConfirm, setTopupConfirm] = useState(false);
  const [confirmPayoutId, setConfirmPayoutId] = useState<string | null>(null);
  async function sendPrintPayTopup() {
    const amount = Number(topupAmount);
    const phone = topupPhone.replace(/[\s()-]/g, '');
    if (!/^((07|01)\d{8}|254[17]\d{8}|\+254[17]\d{8})$/.test(phone)) { setError('Enter a valid Kenyan M-Pesa phone number.'); return; }
    if (!Number.isSafeInteger(amount) || amount < 10) { setError('PrintPay top ups must be at least KSh 10.'); return; }
    if (!topupConfirm) { setTopupConfirm(true); setNotice('Review the phone number and amount, then select Confirm STK Push to send the payment prompt.'); return; }
    setTopupConfirm(false);
    setTopupLoading(true); setError(''); setNotice('');
    try {
      const result: any = await apiFetch('/api/admin/marketplace-payouts', { method: 'POST', body: JSON.stringify({ action: 'PRINTPAY_TOPUP', phone: topupPhone, amount }) });
      setNotice(result.message || 'PrintPay accepted the STK Push request. Confirm the payment in PrintPay.');
    } catch (err: any) { setError(err?.message || 'PrintPay STK Push request failed.'); }
    finally { setTopupLoading(false); }
  }
  async function refresh() {
    setLoading(true); setError('');
    try { const result: any = await apiFetch('/api/admin/marketplace-payouts'); setPayouts(Array.isArray(result.payouts) ? result.payouts : []); setRefunds(Array.isArray(result.refundsToReconcile) ? result.refundsToReconcile : []); }
    catch (err: any) { setError(err?.message || 'Could not load payout requests.'); }
    finally { setLoading(false); }
  }
  useEffect(() => { void refresh(); }, []);
  async function checkPrintPayBalance() {
    setBalanceLoading(true); setError(''); setNotice('');
    try {
      const result: any = await apiFetch('/api/admin/marketplace-payouts', {
        method: 'POST', body: JSON.stringify({ action: 'PRINTPAY_BALANCE' }),
      });
      setPrintPayBalance({ walletId: result.walletId, balance: Number(result.balance), currency: result.currency || 'KES' });
      setNotice('PrintPay API balance check succeeded.');
    } catch (err: any) {
      setPrintPayBalance(null);
      setError(err?.message || 'Could not read the PrintPay balance through the API.');
    } finally { setBalanceLoading(false); }
  }
  async function act(payout: Payout, action: 'APPROVE' | 'REJECT' | 'MARK_PAID' | 'SEND_PRINTPAY') {
    if (action === 'MARK_PAID' && !references[payout.id]?.trim()) { setError('Enter the confirmed M-Pesa/provider reference after sending the money.'); return; }
    setBusy(payout.id); setError(''); setNotice('');
    try {
      const result: any = await apiFetch('/api/admin/marketplace-payouts', { method: 'POST', body: JSON.stringify({ payoutId: payout.id, action, reason: notes[payout.id]?.trim() || '', providerReference: references[payout.id]?.trim() || '' }) });
      setNotice(result.message || 'Payout updated.');
      await refresh();
    } catch (err: any) { setError(err?.message || 'Could not update this payout.'); }
    finally { setBusy(null); }
  }
  async function requestPrintPaySend(payout: Payout) {
    if (confirmPayoutId !== payout.id) { setConfirmPayoutId(payout.id); setNotice('Review the seller, destination, and amount. Confirm only if you intend to initiate a real transfer.'); setError(''); return; }
    setConfirmPayoutId(null);
    await act(payout, 'SEND_PRINTPAY');
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
    <div className="flex flex-wrap items-center justify-between gap-3 mb-6"><div><p className="text-xs font-semibold tracking-wide text-neutral-500">HERSTEP MARKETPLACE</p><h1 className="text-3xl font-bold mt-1">Seller payouts</h1><p className="text-sm text-neutral-600 mt-2">Approve seller requests and send approved payouts through PrintPay B2C. PrintPay acceptance means processing has started, not that final delivery is confirmed.</p></div><div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => void checkPrintPayBalance()} disabled={balanceLoading}>{balanceLoading ? 'Checking PrintPay…' : 'Check PrintPay API balance'}</Button><Button variant="outline" onClick={() => void refresh()} disabled={loading}><RefreshCw className="w-4 h-4 mr-2" /> Refresh</Button></div></div>
    <Card className="p-4 mb-4"><h2 className="font-semibold">Test PrintPay STK Push top up</h2><p className="text-sm text-neutral-600 mt-1">This sends a real M-Pesa payment prompt. Use your own phone for testing; the phone owner must approve it.</p><div className="grid grid-cols-1 sm:grid-cols-3 gap-3 mt-3"><label className="text-xs font-medium">M-Pesa phone number<input value={topupPhone} onChange={e => setTopupPhone(e.target.value)} className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm" placeholder="07XXXXXXXX" /></label><label className="text-xs font-medium">Amount (KSh)<input type="number" min="10" step="1" value={topupAmount} onChange={e => setTopupAmount(e.target.value)} className="mt-1 w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm" /></label><div className="flex items-end"><Button onClick={() => void sendPrintPayTopup()} disabled={topupLoading}>{topupLoading ? 'Sending request…' : topupConfirm ? 'Confirm STK Push' : 'Review STK Push'}</Button>{topupConfirm && <Button variant="outline" onClick={() => { setTopupConfirm(false); setNotice(''); }} disabled={topupLoading}>Cancel</Button>}</div></div></Card>
    {printPayBalance && <Card className="p-4 mb-4"><p className="text-sm text-neutral-500">PrintPay API wallet balance</p><p className="text-2xl font-bold">{money(printPayBalance.balance)}</p>{printPayBalance.walletId && <p className="text-xs text-neutral-500 mt-1">Wallet: {printPayBalance.walletId}</p>}<p className="text-xs text-neutral-500 mt-1">This is a read-only API check; it does not send money.</p></Card>}
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
      {(payout as any).printPayProviderMessage && <p className="text-sm mt-2 text-neutral-600">PrintPay: {(payout as any).printPayProviderMessage}</p>}
      {(payout.status === 'PROVIDER_UNKNOWN' || payout.status === 'DISPATCHING') && <p className="text-sm mt-2 rounded bg-amber-50 p-3 text-amber-800">PrintPay outcome needs checking. Do not send again until reconciled in the PrintPay dashboard.</p>}
      {payout.status === 'PROCESSING' && <p className="text-sm mt-2 rounded bg-blue-50 p-3 text-blue-800">Transfer initialized by PrintPay. Verify final delivery in the provider dashboard before recording it as paid.</p>}
      {['REQUESTED','PENDING','APPROVED','PROCESSING','PROVIDER_UNKNOWN','DISPATCHING'].includes(String(payout.status || 'REQUESTED').toUpperCase()) && <div className="mt-4 grid gap-3">
        <div><label className="block text-xs font-medium mb-1" htmlFor={`payout-note-${payout.id}`}>Review note / reason</label><input id={`payout-note-${payout.id}`} value={notes[payout.id] || ''} onChange={e => setNotes(prev => ({ ...prev, [payout.id]: e.target.value }))} className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm" placeholder="Reason for approval or rejection" /></div>
        {['APPROVED','PROCESSING','PROVIDER_UNKNOWN'].includes(String(payout.status || '').toUpperCase()) && <div><label className="block text-xs font-medium mb-1" htmlFor={`payout-ref-${payout.id}`}>Confirmed provider reference (only after verifying payment)</label><input id={`payout-ref-${payout.id}`} value={references[payout.id] || ''} onChange={e => setReferences(prev => ({ ...prev, [payout.id]: e.target.value }))} className="w-full rounded-lg border border-neutral-300 px-3 py-2 text-sm" placeholder="M-Pesa transaction reference after payment" /></div>}
        <div className="flex flex-wrap gap-2">{['REQUESTED','PENDING'].includes(String(payout.status || 'REQUESTED').toUpperCase()) && <><Button size="sm" disabled={busy === payout.id} onClick={() => void act(payout,'APPROVE')}><CheckCircle2 className="w-4 h-4 mr-1" /> Approve</Button><Button size="sm" variant="outline" disabled={busy === payout.id} onClick={() => void act(payout,'REJECT')}><XCircle className="w-4 h-4 mr-1" /> Reject</Button></>}{String(payout.status || '').toUpperCase() === 'APPROVED' && <><Button size="sm" disabled={busy === payout.id} onClick={() => void requestPrintPaySend(payout)}><Banknote className="w-4 h-4 mr-1" /> {busy === payout.id ? 'Sending…' : confirmPayoutId === payout.id ? 'Confirm real transfer' : 'Review PrintPay transfer'}</Button>{confirmPayoutId === payout.id && <Button size="sm" variant="outline" onClick={() => setConfirmPayoutId(null)}>Cancel</Button>}<Button size="sm" variant="outline" disabled={busy === payout.id} onClick={() => void act(payout,'MARK_PAID')}><CheckCircle2 className="w-4 h-4 mr-1" /> Record external payment</Button></>}{['PROCESSING','PROVIDER_UNKNOWN'].includes(String(payout.status || '').toUpperCase()) && <Button size="sm" disabled={busy === payout.id} onClick={() => void act(payout,'MARK_PAID')}><CheckCircle2 className="w-4 h-4 mr-1" /> Record verified payment</Button>}</div>
      </div>}
    </Card>)}</div>}
  </div>;
}
