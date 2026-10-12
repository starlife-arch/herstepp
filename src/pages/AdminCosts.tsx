import React, { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, ReceiptText } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { usePageMeta } from '../hooks/usePageMeta';
import { Button, Card, Input, formatCurrency, formatDate } from '../components/ui';

type Expense = { id: string; amount: number; description: string; category: string; expenseDate: string; reference?: string };
type MissingCost = { orderId: string; itemIndex: number; productId: string; name: string; size: string; quantity: number; unitPrice: number; unitCost: number | null; orderCreatedAt: string | null };
const categories = ['DELIVERY','PACKAGING','ADVERTISING','RENT','UTILITIES','FEES','SUPPLIES','OTHER'];
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Nairobi' });

export default function AdminCosts() {
  usePageMeta('Cost & Profit Management | HerStep Collection');
  const [rows, setRows] = useState<Expense[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState('OTHER');
  const [expenseDate, setExpenseDate] = useState(today);
  const [reference, setReference] = useState('');
  const [missingCosts, setMissingCosts] = useState<MissingCost[]>([]);
  const [costInputs, setCostInputs] = useState<Record<string, string>>({});
  const [costBusy, setCostBusy] = useState<string | null>(null);
  const total = useMemo(() => rows.reduce((sum, row) => sum + (Number(row.amount) || 0), 0), [rows]);

  async function load() {
    setLoading(true); setError('');
    try { const data = await apiFetch('/api/admin/expenses'); setRows(Array.isArray(data) ? data : []); }
    catch (e: any) { setError(e?.message || 'Could not load expenses.'); }
    finally { setLoading(false); }
  }
  async function loadMissingCosts() {
    try { const data = await apiFetch('/api/admin/order-costs'); setMissingCosts(Array.isArray(data) ? data : []); }
    catch (e: any) { setError(e?.message || 'Could not load paid orders missing cost data.'); }
  }
  React.useEffect(() => { void load(); void loadMissingCosts(); }, []);

  async function saveHistoricalCost(row: MissingCost) {
    const key = row.orderId + ':' + row.itemIndex;
    const raw = costInputs[key];
    const unitCost = Number(raw);
    if (raw === undefined || raw.trim() === '' || !Number.isInteger(unitCost) || unitCost < 0) { setError('Enter a non-negative whole KSh cost price.'); return; }
    setCostBusy(key); setError('');
    try {
      await apiFetch('/api/admin/order-costs', { method: 'POST', body: JSON.stringify({ orderId: row.orderId, itemIndex: row.itemIndex, unitCost }) });
      setMissingCosts(current => current.filter(item => !(item.orderId === row.orderId && item.itemIndex === row.itemIndex)));
      setCostInputs(current => { const next = { ...current }; delete next[key]; return next; });
    } catch (e: any) { setError(e?.message || 'Could not save historical cost.'); }
    finally { setCostBusy(null); }
  }

  async function save(e: React.FormEvent) {
    e.preventDefault(); setSaving(true); setError('');
    try {
      await apiFetch('/api/admin/expenses', { method: 'POST', body: JSON.stringify({ amount: Number(amount), description, category, expenseDate, reference }) });
      setAmount(''); setDescription(''); setReference('');
      await load();
    } catch (e: any) { setError(e?.message || 'Could not save expense.'); }
    finally { setSaving(false); }
  }

  return <div className="space-y-6 animate-fadeIn">
    <div className="flex items-center gap-3"><Link to="/admin/ai" className="rounded-lg border p-2" aria-label="Back to Admin AI"><ArrowLeft className="h-4 w-4" /></Link><div><h1 className="text-2xl font-bold text-neutral-900">Cost &amp; Profit Management</h1><p className="text-sm text-neutral-500">Record operating expenses. Product purchase costs are entered under Admin → Products by size.</p></div></div>
    {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
    <Card><div className="space-y-4 p-4"><div><p className="text-sm text-neutral-500">Recorded expenses in this list (up to 300 recent records)</p><p className="text-2xl font-bold">{formatCurrency(total)}</p></div>
      <form onSubmit={save} className="space-y-4">
        <h2 className="font-semibold">Add business expense</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input label="Amount (KSh)" inputMode="numeric" value={amount} onChange={e => setAmount(e.target.value)} />
          <div><label className="mb-1 block text-sm font-medium text-neutral-700">Category</label><select className="w-full rounded-lg border border-neutral-300 px-3 py-2.5" value={category} onChange={e => setCategory(e.target.value)}>{categories.map(c => <option key={c} value={c}>{c.charAt(0) + c.slice(1).toLowerCase()}</option>)}</select></div>
          <Input label="Expense date" type="date" value={expenseDate} onChange={e => setExpenseDate(e.target.value)} />
          <Input label="Receipt/reference (optional)" value={reference} onChange={e => setReference(e.target.value)} />
        </div>
        <Input label="Description" value={description} onChange={e => setDescription(e.target.value)} />
        <Button type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save expense'}</Button>
      </form>
    </div></Card>
    <Card><div className="space-y-3 p-4"><h2 className="font-semibold">Historical paid-order costs</h2><p className="text-sm text-neutral-500">These are paid order items in the latest 100 paid orders with no saved cost. Use your actual purchase records; saving here updates only the item's cost, not its payment or order status.</p>{missingCosts.length ? <div className="space-y-3">{missingCosts.map(row => { const key = row.orderId + ':' + row.itemIndex; return <div key={key} className="grid grid-cols-1 sm:grid-cols-[1fr_0.7fr_1fr_auto] gap-2 items-center rounded-lg border border-neutral-200 p-3"><div><p className="text-sm font-medium">{row.name}{row.size ? ` · Size ${row.size}` : ''}</p><p className="text-xs text-neutral-500">Order {row.orderId.slice(0, 10)}… · Qty {row.quantity} · Sold at {formatCurrency(row.unitPrice)} each</p></div><Input label="Cost per item (KSh)" value={costInputs[key] || ''} onChange={e => setCostInputs(current => ({ ...current, [key]: e.target.value }))} placeholder="Actual cost" /><div className="text-xs text-neutral-500">Line quantity: {row.quantity}</div><Button disabled={costBusy === key} onClick={() => void saveHistoricalCost(row)}>{costBusy === key ? 'Saving…' : 'Save cost'}</Button></div>; })}</div> : <p className="text-sm text-neutral-500">No missing costs in the latest 100 paid orders, or all items in that sample already have costs.</p>}</div></Card>
    <Card><div className="p-4"><h2 className="mb-3 font-semibold">Recent expenses</h2>{loading ? <p className="text-sm text-neutral-500">Loading…</p> : rows.length ? <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr className="border-b text-neutral-500"><th className="p-2">Date</th><th className="p-2">Category</th><th className="p-2">Description</th><th className="p-2">Reference</th><th className="p-2 text-right">Amount</th></tr></thead><tbody>{rows.map(row => <tr key={row.id} className="border-b border-neutral-100"><td className="p-2">{row.expenseDate}</td><td className="p-2">{row.category}</td><td className="p-2">{row.description}</td><td className="p-2">{row.reference || '—'}</td><td className="p-2 text-right">{formatCurrency(row.amount)}</td></tr>)}</tbody></table></div> : <p className="text-sm text-neutral-500">No expenses recorded yet.</p>}</div></Card>
    <p className="text-xs text-neutral-500">Expenses are recorded separately from product costs. This page does not yet claim a complete net-profit figure unless sales, product costs and expenses for the same period are all complete.</p>
  </div>;
}
