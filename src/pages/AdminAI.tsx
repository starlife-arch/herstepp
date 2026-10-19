import React, { useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, Send, Sparkles, RefreshCw } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { Button, Card } from '../components/ui';

type ChatMessage = { role: 'admin' | 'assistant'; content: string };
type Report = {
  sampleWindow?: { orders: number; note: string };
  sales?: { paidOrderCount: number; paidOrderValue: number; pendingPaymentCount: number; pendingOrderCount: number };
  stock?: { activeProducts: number; unitsInStock: number; lowStockVariants: number; outOfStockVariants: number; lowStockItems?: Array<{ name: string; size: string; quantity: number }> };
  bestSellers?: Array<{ name: string; unitsSold: number; orderCount: number; salesValue: number }>;
  refunds?: { recordCount: number; statuses: Record<string, number>; completedCount: number; completedAmount: number; sampleWindow: string };
  support?: { ticketCount: number };
  tips?: { paidTipCount: number; paidTipValue: number };
  profit?: { knownGrossProfit: number | null; knownCostPaidOrderCount: number; paidOrderCount: number; note: string };
};

const prompts = [
  'Summarise sales and payments',
  'Which stock is low?',
  'Show best-selling products',
  'Summarise refunds and returns',
  'How many orders are pending?',
  'Summarise support tickets',
  'How much have customers tipped?',
  'Can we calculate profit?',
];

const money = (value: number) => 'KSh ' + Number(value || 0).toLocaleString('en-KE', { maximumFractionDigits: 0 });

export default function AdminAI() {
  const [messages, setMessages] = useState<ChatMessage[]>([
    { role: 'assistant', content: 'Hello! I’m your private HerStep Admin AI. I can summarise sales, orders, payment statuses, stock, support tickets and paid tips using live records. I’m read-only: I won’t change orders or business records. I will not guess profit when cost data is missing.' },
  ]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [report, setReport] = useState<Report | null>(null);

  async function ask(question = input) {
    const prompt = question.trim();
    if (!prompt || sending) return;
    setMessages(current => [...current, { role: 'admin', content: prompt }]);
    setInput('');
    setSending(true);
    setError('');
    try {
      const result: any = await apiFetch('/api/admin/ai', { method: 'POST', body: JSON.stringify({ message: prompt }) });
      if (result?.readOnly !== true || typeof result?.answer !== 'string') throw new Error('The Admin AI response was incomplete.');
      setMessages(current => [...current, { role: 'assistant', content: result.answer }]);
      setReport(result.report || null);
    } catch (e: any) {
      setError(e?.message || 'Admin AI could not answer. Please try again.');
      setMessages(current => [...current, { role: 'assistant', content: 'I couldn’t retrieve a report just now. Please try again, or use the existing admin dashboard for the live records.' }]);
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="mx-auto max-w-5xl space-y-5">
      <Link to="/admin" className="inline-flex items-center gap-2 text-sm text-neutral-500 hover:text-neutral-900"><ArrowLeft className="w-4 h-4" />Admin dashboard</Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><div className="flex items-center gap-2"><Sparkles className="w-6 h-6" /><h1 className="text-2xl font-bold">Admin AI</h1></div><p className="text-sm text-neutral-500 mt-1">Private business insights from real HerStep records. Read-only in this phase.</p></div>
        <Button variant="outline" onClick={() => { setMessages([{ role: 'assistant', content: 'Ask me about sales, orders, payments, stock, best sellers, refunds, support tickets, tips, or whether cost records are sufficient to estimate gross profit.' }]); setError(''); }}><RefreshCw className="w-4 h-4 mr-2" />New chat</Button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <Card className="p-4"><p className="text-xs text-neutral-500">Paid order value</p><p className="text-lg font-bold mt-1">{report ? money(report.sales?.paidOrderValue || 0) : '—'}</p><p className="text-xs text-neutral-500 mt-1">{report ? (report.sales?.paidOrderCount || 0) + ' paid orders in report' : 'Ask a question to load data'}</p></Card>
        <Card className="p-4"><p className="text-xs text-neutral-500">Stock units</p><p className="text-lg font-bold mt-1">{report ? (report.stock?.unitsInStock || 0).toLocaleString('en-KE') : '—'}</p><p className="text-xs text-neutral-500 mt-1">{report ? (report.stock?.lowStockVariants || 0) + ' low-stock variants' : 'Live inventory snapshot'}</p></Card>
        <Card className="p-4"><p className="text-xs text-neutral-500">Support tickets</p><p className="text-lg font-bold mt-1">{report ? report.support?.ticketCount ?? 0 : '—'}</p><p className="text-xs text-neutral-500 mt-1">Fetched report window</p></Card>
        <Card className="p-4"><p className="text-xs text-neutral-500">Paid tips</p><p className="text-lg font-bold mt-1">{report ? money(report.tips?.paidTipValue || 0) : '—'}</p><p className="text-xs text-neutral-500 mt-1">{report ? (report.tips?.paidTipCount || 0) + ' paid tips' : 'Confirmed payments only'}</p></Card>
      </div>

      {report && <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <Card className="p-4 space-y-3">
          <div className="flex items-center justify-between gap-2"><h2 className="font-semibold text-neutral-900">Best-selling products</h2><span className="text-xs text-neutral-500">Paid orders in report</span></div>
          {report.bestSellers?.length ? <ol className="space-y-2">{report.bestSellers.slice(0, 5).map((item, index) => <li key={(item.productId || item.name) + index} className="flex items-start justify-between gap-3 text-sm"><span className="min-w-0"><span className="mr-2 text-neutral-400">{index + 1}.</span>{item.name}</span><span className="shrink-0 font-medium">{item.unitsSold} sold</span></li>)}</ol> : <p className="text-sm text-neutral-500">No paid-order product items were found in the fetched sample.</p>}
        </Card>
        <Card className="p-4 space-y-3">
          <div className="flex items-center justify-between gap-2"><h2 className="font-semibold text-neutral-900">Low-stock alerts</h2><span className="text-xs text-neutral-500">{report.stock?.outOfStockVariants || 0} out of stock</span></div>
          {report.stock?.lowStockItems?.length ? <ul className="space-y-2">{report.stock.lowStockItems.slice(0, 8).map((item, index) => <li key={item.name + item.size + index} className="flex items-start justify-between gap-3 text-sm"><span className="min-w-0">{item.name}{item.size ? <span className="text-neutral-500"> · Size {item.size}</span> : ''}</span><span className={'shrink-0 font-semibold ' + (item.quantity === 0 ? 'text-red-700' : 'text-amber-700')}>{item.quantity === 0 ? 'Out of stock' : item.quantity + ' left'}</span></li>)}</ul> : <p className="text-sm text-neutral-500">No low-stock variants found in the fetched active catalogue.</p>}
        </Card>
        <Card className="p-4 space-y-2 lg:col-span-2">
          <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-semibold text-neutral-900">Refund reporting</h2><span className="text-xs text-neutral-500">Recent records only</span></div>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <div><p className="text-xs text-neutral-500">Records</p><p className="text-lg font-bold">{report.refunds?.recordCount ?? '—'}</p></div>
            <div><p className="text-xs text-neutral-500">Completed/paid</p><p className="text-lg font-bold">{report.refunds?.completedCount ?? '—'}</p></div>
            <div><p className="text-xs text-neutral-500">Recorded completed amount</p><p className="text-lg font-bold">{report.refunds ? money(report.refunds.completedAmount) : '—'}</p></div>
            <div><p className="text-xs text-neutral-500">Status breakdown</p><p className="text-sm font-medium">{report.refunds ? Object.entries(report.refunds.statuses).map(([key, value]) => key + ': ' + value).join(' · ') || 'No records' : '—'}</p></div>
          </div>
          <p className="text-xs text-neutral-500">{report.refunds?.sampleWindow || 'Refunds are loaded from the recent refund-record sample.'}</p>
        </Card>
      </div>}

      <Card className="p-4 sm:p-5 space-y-4">
        <div className="flex flex-wrap gap-2">
          {prompts.map(prompt => <button key={prompt} type="button" onClick={() => void ask(prompt)} disabled={sending} className="rounded-full border border-neutral-200 px-3 py-2 text-xs sm:text-sm hover:bg-neutral-50 disabled:opacity-50">{prompt}</button>)}
        </div>
        <div aria-live="polite" className="max-h-[52vh] min-h-64 overflow-y-auto space-y-3 rounded-xl bg-neutral-50 p-3 sm:p-4">
          {messages.map((message, index) => <div key={index} className={'flex ' + (message.role === 'admin' ? 'justify-end' : 'justify-start')}><div className={'max-w-[95%] sm:max-w-[85%] whitespace-pre-wrap rounded-2xl px-4 py-3 text-sm ' + (message.role === 'admin' ? 'bg-neutral-900 text-white' : 'bg-white border border-neutral-200 text-neutral-800')}>{message.content}</div></div>)}
          {sending && <p className="text-xs text-neutral-500">Checking the latest report…</p>}
        </div>
        {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
        <form onSubmit={event => { event.preventDefault(); void ask(); }} className="flex gap-2">
          <input value={input} onChange={event => setInput(event.target.value)} maxLength={1000} placeholder="Ask about sales, stock, payments, orders…" className="min-w-0 flex-1 rounded-xl border border-neutral-300 px-3 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-neutral-900" />
          <Button type="submit" disabled={sending || !input.trim()}><Send className="w-4 h-4 mr-1" />Ask</Button>
        </form>
        <p className="text-xs text-neutral-500">Read-only safeguards: the assistant cannot edit records. Figures are based on bounded report samples. Profit is not guessed when item cost data is incomplete.</p>
      </Card>
    </div>
  );
}
