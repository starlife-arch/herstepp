// Admin panel — REAL data only. No mock imports: products come from
// GET /api/admin/products, categories from GET /api/categories, customers from
// GET /api/admin/customers and orders/payments/overview from
// GET /api/admin/orders. Tabs without a Phase 1 backend show "Coming soon".
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { LayoutDashboard, ShoppingBag, Package, Users, CreditCard, MessageSquare, Mail, Tag, Bell, Settings, LogOut, TrendingUp, AlertTriangle, X, Upload, Heart, FileText } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { apiFetch, apiDownload } from '../lib/api';
import { productImageUrl, handleImageError } from '../lib/productImage';
import { SupportChat } from '../components/SupportChat';
import { toUiTicket } from '../lib/supportAdapter';
import { ORDER_STATUSES, nextOrderStatuses, humanStatus } from '../lib/orderTransitions';
import { Card, Badge, Button, formatCurrency, formatDate, getStatusBadge, EmptyState, Input } from '../components/ui';
import { deliveryFee as previewDeliveryFee, normalizeDelivery } from '../lib/delivery';
import type { AdminDeliveryResponse, AdminNotificationsResponse } from '../lib/apiTypes';

// formatCurrency/formatDate accept Firestore Timestamps and strings too; keep a
// local wrapper so the admin tables never crash on odd shapes (safe defaults).
const money = (amount: any) => formatCurrency(Number(amount) || 0);
const day = (d: any) => {
  const iso = typeof d === 'string' ? d : d?.toDate?.()?.toISOString?.() ?? null;
  return iso ? formatDate(iso) : '—';
};

const SIZES = Array.from({ length: 16 }, (_, i) => String(30 + i)); // "30".."45"

// Small toast so status changes give visible feedback (auto-dismisses).
function Toast({ message }: { message: string }) {
  return (
    <div role="status" className="fixed bottom-6 right-6 z-50 bg-emerald-600 text-white text-sm font-medium px-4 py-3 rounded-lg shadow-lg animate-fadeIn">
      {message}
    </div>
  );
}

type Async<T> = { loading: boolean; error: string | null; data: T | null };

function useAdminData<T>(path: string): Async<T> & { reload: () => void; loadMore?: (cursor: unknown) => Promise<void>; loadingMore?: boolean } {
  const [state, setState] = useState<Async<T>>({ loading: true, error: null, data: null });
  const [loadingMore, setLoadingMore] = useState(false);
  const load = useCallback(async () => {
    setState(s => ({ ...s, loading: true, error: null }));
    try {
      const data = await apiFetch(path);
      setState({ loading: false, error: null, data });
    } catch (err: any) {
      setState({ loading: false, error: err?.message || 'Could not load data.', data: null });
    }
  }, [path]);
  // Cursor "Load more": appends one more bounded page without refetching the
  // whole list. Only used by routes that support ?cursor= (admin orders).
  const loadMore = useCallback(async (cursor: unknown) => {
    setLoadingMore(true);
    try {
      const sep = path.includes('?') ? '&' : '?';
      const data: any = await apiFetch(`${path}${sep}cursor=${encodeURIComponent(String(cursor))}`);
      setState(prev => {
        const oldList: any[] = Array.isArray(prev.data) ? prev.data : (prev.data as any)?.orders ?? [];
        const newOrders: any[] = Array.isArray(data) ? data : (data?.orders ?? []);
        const merged = [...oldList, ...newOrders];
        const base: any = prev.data && !Array.isArray(prev.data) ? prev.data : {};
        return { loading: false, error: null, data: { ...base, ...data, orders: merged } as any };
      });
    } catch (err: any) {
      setState(prev => ({ ...prev, error: err?.message || 'Could not load more.' }));
    } finally {
      setLoadingMore(false);
    }
  }, [path]);
  useEffect(() => { load(); }, [load]);
  return { ...state, reload: load, loadMore, loadingMore };
}

function LoadingCard() {
  return <Card className="p-8 text-center text-sm text-neutral-500 animate-pulse">Loading…</Card>;
}

function ErrorCard({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <Card className="p-6 text-center space-y-3">
      <p className="text-sm text-red-600">{message}</p>
      {onRetry && <Button variant="outline" size="sm" onClick={onRetry}>Retry</Button>}
    </Card>
  );
}

// Webhook visibility banner. printpay comes from settings/printpay (written by
// every /api/payments/mpesa/callback call) via GET /api/admin/orders.
function PrintpayCallbackBanner({ printpay }: { printpay: any }) {
  const lastAt = printpay?.lastCallbackAt ?? null;
  const status = printpay?.lastCallbackStatus ?? null;
  if (!lastAt) {
    const siteUrl = typeof window !== 'undefined' ? window.location.origin : '';
    return (
      <div role="alert" className="bg-red-50 border border-red-300 text-red-700 text-sm rounded-lg px-4 py-3">
        <p className="font-semibold">Printpay callback: Never received.</p>
        <p className="mt-1">Set the callback URL in your Printpay dashboard to <span className="font-mono text-xs">{siteUrl}/api/payments/mpesa/callback</span></p>
      </div>
    );
  }
  return (
    <div className="bg-emerald-50 border border-emerald-200 text-emerald-800 text-sm rounded-lg px-4 py-3">
      Printpay callback: last received <span className="font-medium">{relativeTime(lastAt)}</span>{status ? <> (<span className="font-medium">{String(status)}</span>)</> : null}
    </div>
  );
}

function relativeTime(iso: string): string {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return String(iso);
  const diff = Math.max(0, Date.now() - then);
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function AdminSupport({ tickets }: { tickets: any[] }) {
  const [selected, setSelected] = useState<any>(null);
  const [notesOpen, setNotesOpen] = useState(false);
  const [notes, setNotes] = useState<any[]>([]);
  const [note, setNote] = useState('');
  const open = async (ticket: any) => {
    setSelected(ticket);
    await apiFetch('/api/admin/support/read', { method: 'POST', body: JSON.stringify({ ticketDocumentId: ticket.id }) }).catch(() => undefined);
    const result: any = await apiFetch(`/api/admin/support/notes?ticketDocumentId=${encodeURIComponent(ticket.id)}`).catch(() => ({ notes: [] }));
    setNotes(result.notes || []);
  };
  const changeStatus = async (status: string) => {
    await apiFetch('/api/admin/support/status', { method: 'PATCH', body: JSON.stringify({ ticketDocumentId: selected.id, status }) });
    setSelected({ ...selected, status: toUiTicket({ ...selected, status }, []).status });
  };
  if (selected) return <div className="space-y-4"><Card className="p-4"><div className="flex items-center gap-3"><a className="text-sm font-mono text-neutral-600" href={selected.orderDocumentId ? `/orders/${selected.orderDocumentId}` : undefined}>{selected.orderId || 'No linked order'}</a><select value="" onChange={event => event.target.value && changeStatus(event.target.value)} className="px-3 py-2 border border-neutral-300 rounded-lg text-sm"><option value="">Change status</option>{({ open: ['IN_PROGRESS', 'WAITING_FOR_CUSTOMER', 'RESOLVED', 'CLOSED'], in_progress: ['WAITING_FOR_CUSTOMER', 'RESOLVED', 'CLOSED'], waiting_customer: ['IN_PROGRESS', 'RESOLVED', 'CLOSED'], resolved: ['IN_PROGRESS', 'WAITING_FOR_CUSTOMER', 'CLOSED'], closed: [] } as any)[selected.status].map((status: string) => <option key={status} value={status}>{status.replace(/_/g, ' ')}</option>)}</select><Button variant="outline" size="sm" onClick={() => setNotesOpen(value => !value)}>Internal notes</Button></div>{notesOpen && <div className="mt-4 space-y-2"><div className="space-y-1">{notes.map(item => <p key={item.id} className="text-sm text-neutral-600">{item.authorName}: {item.body}</p>)}</div><div className="flex gap-2"><input value={note} onChange={event => setNote(event.target.value)} className="flex-1 px-3 py-2 border border-neutral-300 rounded-lg text-sm" placeholder="Add internal note" /><Button size="sm" onClick={async () => { if (!note.trim()) return; await apiFetch('/api/admin/support/notes', { method: 'POST', body: JSON.stringify({ ticketDocumentId: selected.id, body: note }) }); setNote(''); }}>Add</Button></div></div>}</Card><SupportChat ticket={selected} admin onBack={() => setSelected(null)} /></div>;
  return <div className="space-y-6 animate-fadeIn"><h1 className="text-2xl font-bold text-neutral-900">Support Tickets</h1><div className="grid grid-cols-2 sm:grid-cols-4 gap-4 mb-6"><StatCard title="Open" value={tickets.filter(ticket => ticket.status === 'open').length.toString()} /><StatCard title="In Progress" value={tickets.filter(ticket => ticket.status === 'in_progress').length.toString()} /><StatCard title="Resolved" value={tickets.filter(ticket => ticket.status === 'resolved').length.toString()} /><StatCard title="Closed" value={tickets.filter(ticket => ticket.status === 'closed').length.toString()} /></div><div className="space-y-3">{tickets.map(ticket => <Card key={ticket.id} className="p-4"><div onClick={() => open(ticket)} className="flex items-start justify-between cursor-pointer"><div><div className="flex items-center gap-2 mb-1"><span className="text-xs font-mono text-neutral-500">{ticket.ticketId}</span><Badge variant={getStatusBadge(ticket.status).variant}>{getStatusBadge(ticket.status).label}</Badge></div><p className="font-medium text-sm text-neutral-900">{ticket.subject}</p><p className="text-xs text-neutral-500 mt-1">{ticket.customerName} | {ticket.category}</p></div><Button variant="ghost" size="sm">Open</Button></div></Card>)}</div></div>;
}

function ComingSoon({ title }: { title: string }) {
  return (
    <div className="space-y-6 animate-fadeIn">
      <h1 className="text-2xl font-bold text-neutral-900">{title}</h1>
      <Card className="p-10 text-center">
        <div className="w-14 h-14 mx-auto mb-4 rounded-full bg-neutral-100 flex items-center justify-center">
          <Settings className="w-6 h-6 text-neutral-400" />
        </div>
        <h3 className="font-semibold text-neutral-900">Coming soon</h3>
        <p className="text-sm text-neutral-500 mt-1 max-w-md mx-auto">
          This section is part of Phase 2 and has no backend yet. Nothing here is fake or hardcoded.
        </p>
      </Card>
    </div>
  );
}

function NotificationsPanel() {
  const status = useAdminData<AdminNotificationsResponse>('/api/admin/notifications');
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [working, setWorking] = useState<string | null>(null);
  const run = async (action: 'email' | 'telegram' | 'retry') => {
    setWorking(action); setMessage(null);
    try {
      const endpoint = action === 'retry' ? '/api/admin/notifications/retry' : '/api/admin/notifications/test';
      const result: any = await apiFetch(endpoint, { method: 'POST', body: JSON.stringify(action === 'retry' ? {} : { channel: action }) });
      if (result.sent === false) throw new Error(result.reason === 'not-configured' ? 'This notification channel is not configured in Vercel.' : (result.detail || 'The test message could not be sent.'));
      setMessage({ type: 'success', text: action === 'retry' ? `Retry started for up to ${result.attemptedUpTo} pending emails.` : `Test ${action} sent successfully.` });
      status.reload();
    } catch (error: any) { setMessage({ type: 'error', text: error?.message || 'Could not complete that notification action.' }); }
    finally { setWorking(null); }
  };
  if (status.loading) return <LoadingCard />;
  if (status.error || !status.data) return <ErrorCard message={status.error || 'Could not load notification status.'} onRetry={status.reload} />;
  const { email, telegram } = status.data;
  const statusCard = (label: string, configured: boolean, missing: string[]) => <Card className="p-5"><div className="flex items-start justify-between gap-3"><div><h2 className="font-semibold text-neutral-900">{label}</h2><p className={`mt-1 text-sm font-medium ${configured ? 'text-emerald-700' : 'text-red-700'}`}>{configured ? 'Configured' : 'Not configured'}</p></div><span className={`h-3 w-3 mt-1 rounded-full ${configured ? 'bg-emerald-500' : 'bg-red-500'}`} aria-label={configured ? `${label} configured` : `${label} not configured`} /></div>{!configured && <p className="mt-3 text-xs text-red-700">Add {missing.join(', ') || 'the required variables'} in Vercel.</p>}</Card>;
  return <div className="space-y-6 animate-fadeIn"><div><h1 className="text-2xl font-bold text-neutral-900">Notifications</h1><p className="text-sm text-neutral-500">Monitor delivery channels and safely retry the transactional email outbox.</p></div>{message && <div role="status" className={`rounded-lg border px-4 py-3 text-sm ${message.type === 'success' ? 'border-emerald-200 bg-emerald-50 text-emerald-800' : 'border-red-200 bg-red-50 text-red-700'}`}>{message.text}</div>}<div className="grid gap-4 md:grid-cols-2">{statusCard('Email (Brevo)', email.configured, email.missing)}{statusCard('Telegram', telegram.configured, telegram.missing)}</div><Card className="p-5"><h2 className="font-semibold text-neutral-900">Email outbox</h2><div className="mt-4 grid grid-cols-2 gap-4 sm:max-w-sm"><div className="rounded-lg bg-amber-50 p-3"><p className="text-xs text-amber-800">Pending</p><p className="text-xl font-bold text-amber-950">{email.pending}</p></div><div className="rounded-lg bg-emerald-50 p-3"><p className="text-xs text-emerald-800">Sent (7 days)</p><p className="text-xl font-bold text-emerald-950">{email.sent7d}</p></div></div>{email.failed.length > 0 && <div className="mt-5"><h3 className="text-sm font-semibold text-neutral-900">Recent delivery failures</h3><ul className="mt-2 divide-y divide-neutral-100 rounded-lg border border-neutral-200">{email.failed.map(f => <li key={f.key} className="p-3 text-sm"><p className="font-medium text-neutral-800">{f.to || 'Unknown recipient'}</p><p className="text-red-700">{f.lastError || 'Delivery attempt failed.'}</p></li>)}</ul></div>}</Card><div className="flex flex-wrap gap-3"><Button onClick={() => run('email')} disabled={working !== null}>{working === 'email' ? 'Sending…' : 'Send test email'}</Button><Button variant="outline" onClick={() => run('telegram')} disabled={working !== null}>{working === 'telegram' ? 'Sending…' : 'Send test Telegram'}</Button><Button variant="outline" onClick={() => run('retry')} disabled={working !== null}>{working === 'retry' ? 'Retrying…' : 'Retry pending emails'}</Button></div></div>;
}

function PromotionsPanel() {
  const data = useAdminData<any>('/api/admin/promo-codes'); const [editing,setEditing]=useState<any>(null); const [message,setMessage]=useState('');
  const save=async()=>{try{const body={...editing,code:String(editing.code||'').toUpperCase(),discountValue:Number(editing.discountValue),minimumOrderValue:Number(editing.minimumOrderValue||0),perCustomerUsage:Number(editing.perCustomerUsage||1),maximumUsage:editing.maximumUsage===''?null:Number(editing.maximumUsage),productIds:editing.productIds||[],categoryIds:editing.categoryIds||[]};await apiFetch('/api/admin/promo-codes',{method:editing.exists?'PATCH':'POST',body:JSON.stringify(body)});setEditing(null);setMessage('Promotion saved.');data.reload();}catch(e:any){setMessage(e.message||'Could not save promotion.');}};
  if(data.loading)return <LoadingCard/>; if(data.error)return <ErrorCard message={data.error} onRetry={data.reload}/>;const promos=data.data?.promoCodes||[];
  return <div className="space-y-6 animate-fadeIn"><div className="flex justify-between"><div><h1 className="text-2xl font-bold text-neutral-900">Promotions</h1><p className="text-sm text-neutral-500">Manage product and category promo codes.</p></div><Button onClick={()=>setEditing({code:'',name:'',description:'',discountType:'PERCENTAGE',discountValue:10,active:true,startsAt:new Date().toISOString().slice(0,16),endsAt:'',minimumOrderValue:0,maximumUsage:'',perCustomerUsage:1,productIds:[],categoryIds:[]})}>New promo code</Button></div>{message&&<p role="status" className="text-sm text-emerald-700">{message}</p>}{editing?<Card className="p-5 space-y-3"><h2 className="font-semibold">{editing.exists?'Edit':'New'} promo code</h2><div className="grid gap-3 sm:grid-cols-2"><Input label="Code" value={editing.code} disabled={editing.exists} onChange={e=>setEditing({...editing,code:e.target.value.toUpperCase()})}/><Input label="Name" value={editing.name} onChange={e=>setEditing({...editing,name:e.target.value})}/><Input label="Value" type="number" value={editing.discountValue} onChange={e=>setEditing({...editing,discountValue:e.target.value})}/><select value={editing.discountType} onChange={e=>setEditing({...editing,discountType:e.target.value})} className="border rounded-lg px-3"><option value="PERCENTAGE">Percentage</option><option value="FIXED">Fixed KSh</option></select><Input label="Starts" type="datetime-local" value={editing.startsAt?.slice(0,16)} onChange={e=>setEditing({...editing,startsAt:e.target.value})}/><Input label="Ends" type="datetime-local" value={editing.endsAt?.slice(0,16)} onChange={e=>setEditing({...editing,endsAt:e.target.value})}/><Input label="Minimum order value" type="number" value={editing.minimumOrderValue} onChange={e=>setEditing({...editing,minimumOrderValue:e.target.value})}/><Input label="Uses per customer" type="number" value={editing.perCustomerUsage} onChange={e=>setEditing({...editing,perCustomerUsage:e.target.value})}/></div><label className="text-sm"><input type="checkbox" checked={editing.active} onChange={e=>setEditing({...editing,active:e.target.checked})}/> Active</label><div className="flex gap-2"><Button onClick={save}>Save</Button><Button variant="outline" onClick={()=>setEditing(null)}>Cancel</Button></div></Card>:<Card className="overflow-x-auto"><table className="w-full text-sm"><thead><tr className="text-left border-b"><th className="p-3">Code</th><th>Name</th><th>Discount</th><th>Applies to</th><th>Usage</th><th>Active</th><th></th></tr></thead><tbody>{promos.map((p:any)=><tr key={p.code} className="border-b"><td className="p-3 font-medium">{p.code}</td><td>{p.name}</td><td>{p.discountType==='PERCENTAGE'?`${p.discountValue}%`:`KSh ${p.discountValue}`}</td><td>{!p.productIds?.length&&!p.categoryIds?.length?'All products':`${(p.productIds?.length||0)} selected shoes`}</td><td>{p.usageCount||0} / {p.maximumUsage??'∞'}</td><td>{p.active?'Yes':'No'}</td><td><Button size="sm" variant="outline" onClick={()=>setEditing({...p,exists:true})}>Edit</Button></td></tr>)}</tbody></table></Card>}</div>;
}

type AreaRow = { name: string; fee: string };

function DeliverySettings() {
  const [deliveryEnabled, setDeliveryEnabled] = useState(false);
  const [kiambu, setKiambu] = useState('200');
  const [defaultCounty, setDefaultCounty] = useState('500');
  const [areas, setAreas] = useState<AreaRow[]>([]);
  const [previewLocation, setPreviewLocation] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch('/api/admin/delivery').then((raw: AdminDeliveryResponse) => {
      if (cancelled) return;
      const settings = normalizeDelivery(raw);
      setDeliveryEnabled(settings.deliveryEnabled);
      setKiambu(String(settings.deliveryRates.kiambu));
      setDefaultCounty(String(settings.deliveryRates.defaultCounty));
      setAreas(Object.entries(settings.deliveryRates.counties).map(([name, fee]) => ({ name, fee: String(fee) })));
    }).catch((error: Error) => !cancelled && setMessage({ type: 'error', text: error.message || 'Could not load delivery settings.' }))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, []);

  const previewSettings = normalizeDelivery({ deliveryEnabled, deliveryRates: {
    kiambu: Number(kiambu), defaultCounty: Number(defaultCounty),
    counties: Object.fromEntries(areas.map(area => [area.name.trim(), Number(area.fee)])),
  } });
  const preview = previewDeliveryFee(previewSettings, previewLocation);
  const updateArea = (index: number, field: keyof AreaRow, value: string) => setAreas(rows => rows.map((row, i) => i === index ? { ...row, [field]: value } : row));
  const save = async () => {
    setSaving(true); setMessage(null);
    try {
      const counties = Object.fromEntries(areas.map(area => [area.name.trim(), Number(area.fee)]));
      const result = await apiFetch('/api/admin/delivery', { method: 'PATCH', body: JSON.stringify({ deliveryEnabled, deliveryRates: { kiambu: Number(kiambu), defaultCounty: Number(defaultCounty), counties } }) }) as AdminDeliveryResponse;
      const settings = normalizeDelivery(result);
      setKiambu(String(settings.deliveryRates.kiambu)); setDefaultCounty(String(settings.deliveryRates.defaultCounty));
      setAreas(Object.entries(settings.deliveryRates.counties).map(([name, fee]) => ({ name, fee: String(fee) })));
      setMessage({ type: 'success', text: 'Delivery settings saved.' });
    } catch (error: any) { setMessage({ type: 'error', text: error?.message || 'Could not save delivery settings.' }); }
    finally { setSaving(false); }
  };

  if (loading) return <LoadingCard />;
  return <div className="space-y-6 animate-fadeIn">
    <div><h1 className="text-2xl font-bold text-neutral-900">Settings</h1><p className="text-sm text-neutral-500">Configure checkout delivery availability and rates.</p></div>
    <Card className="p-6 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div><h2 className="text-lg font-semibold text-neutral-900">Delivery</h2><p className="text-sm text-neutral-500 mt-1">Juja is always free. Collection is always available.</p></div>
        <label className="inline-flex items-center gap-2 text-sm font-medium text-neutral-700 cursor-pointer"><input type="checkbox" checked={deliveryEnabled} onChange={e => setDeliveryEnabled(e.target.checked)} className="h-4 w-4" /> Offer delivery</label>
      </div>
      {!deliveryEnabled && <div role="alert" className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">Customers can only choose collection.</div>}
      {message && <div role="status" className={`rounded-lg px-4 py-3 text-sm ${message.type === 'success' ? 'bg-emerald-50 text-emerald-800 border border-emerald-200' : 'bg-red-50 text-red-700 border border-red-200'}`}>{message.text}</div>}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4"><Input label="Kiambu fee" type="number" min="0" step="1" value={kiambu} onChange={e => setKiambu(e.target.value)} /><Input label="Other areas (default) fee" type="number" min="0" step="1" value={defaultCounty} onChange={e => setDefaultCounty(e.target.value)} /></div>
      <div className="space-y-3"><div><h3 className="font-medium text-neutral-900">Specific areas</h3><p className="text-xs text-neutral-500">Add an area name and its fee. Matching is case-insensitive.</p></div>
        {areas.map((area, index) => <div className="flex gap-2" key={index}><input aria-label={`Area ${index + 1} name`} value={area.name} maxLength={80} onChange={e => updateArea(index, 'name', e.target.value)} placeholder="Area name" className="min-w-0 flex-1 px-3.5 py-2.5 border border-neutral-300 rounded-lg text-sm" /><input aria-label={`Area ${index + 1} fee`} value={area.fee} type="number" min="0" step="1" onChange={e => updateArea(index, 'fee', e.target.value)} placeholder="Fee" className="w-28 px-3.5 py-2.5 border border-neutral-300 rounded-lg text-sm" /><Button type="button" variant="outline" onClick={() => setAreas(rows => rows.filter((_, i) => i !== index))}>Remove</Button></div>)}
        <Button type="button" variant="outline" onClick={() => setAreas(rows => [...rows, { name: '', fee: '0' }])}>Add area</Button>
      </div>
      <div className="rounded-xl bg-neutral-50 border border-neutral-200 p-4"><h3 className="font-medium text-neutral-900">Fee preview</h3><div className="mt-3 flex flex-col sm:flex-row gap-3 sm:items-end"><div className="flex-1"><Input label="Location" value={previewLocation} onChange={e => setPreviewLocation(e.target.value)} placeholder="Type a delivery location" /></div><p className="pb-2 text-sm text-neutral-700">{deliveryEnabled ? <>Fee: <strong>{preview === 0 ? 'Free' : formatCurrency(preview)}</strong></> : 'Delivery is off'}</p></div></div>
      <div className="flex justify-end"><Button onClick={save} disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button></div>
    </Card>
  </div>;
}

export default function AdminDashboard() {
  const { state, logout } = useApp();
  const navigate = useNavigate();
  const [activeSection, setActiveSection] = useState('overview');

  const ordersRes = useAdminData<any>('/api/admin/orders');
  const supportRes = useAdminData<any>('/api/admin/support');
  const supportTickets = useMemo(() => (supportRes.data?.tickets || []).map((ticket: any) => toUiTicket(ticket, [])), [supportRes.data]);
  const unreadSupport = supportTickets.filter((ticket: any) => ticket.hasUnreadAdminMessages).length;
  // GET /api/admin/orders returns { orders: [...], printpay: {...} } (wrapped).
  // Normalise defensively so BOTH the wrapped shape and a legacy bare array work.
  const orders = useMemo(() => {
    const d: any = ordersRes.data;
    return Array.isArray(d) ? d : Array.isArray(d?.orders) ? d.orders : [];
  }, [ordersRes.data]);
  const printpay = useMemo(() => {
    const d: any = ordersRes.data;
    return (d && !Array.isArray(d) && d.printpay && typeof d.printpay === 'object') ? d.printpay : null;
  }, [ordersRes.data]);

  if (!state.user || (state.user.role !== 'ADMIN' && state.user.role !== 'SUPER_ADMIN')) {
    navigate('/login');
    return null;
  }

  const navItems = [
    { id: 'overview', label: 'Overview', icon: LayoutDashboard },
    { id: 'orders', label: 'Orders', icon: ShoppingBag },
    { id: 'products', label: 'Products', icon: Package },
    { id: 'customers', label: 'Customers', icon: Users },
    { id: 'payments', label: 'Payments', icon: CreditCard },
    { id: 'tips', label: 'Tips', icon: Heart },
    { id: 'support', label: 'Support', icon: MessageSquare },
    { id: 'promotions', label: 'Promotions', icon: Tag },
    { id: 'notifications', label: 'Notifications', icon: Bell },
    { id: 'settings', label: 'Settings', icon: Settings },
  ];

  return (
    <div className="min-h-screen bg-neutral-50 flex">
      {/* Sidebar */}
      <aside className="hidden lg:flex flex-col w-64 bg-white border-r border-neutral-200 fixed h-full">
        <div className="p-5 border-b border-neutral-200">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 bg-neutral-900 rounded-lg flex items-center justify-center">
              <span className="text-white font-bold text-sm">H</span>
            </div>
            <div>
              <span className="font-semibold text-neutral-900">HerStep</span>
              <span className="text-neutral-400 text-xs block -mt-0.5">Admin Panel</span>
            </div>
          </div>
        </div>
        <nav className="flex-1 p-3 space-y-1 overflow-y-auto">
          {navItems.map(item => (
            <button
              key={item.id}
              onClick={() => setActiveSection(item.id)}
              className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors ${activeSection === item.id ? 'bg-neutral-100 text-neutral-900' : 'text-neutral-600 hover:bg-neutral-50'}`}
            >
              <item.icon className="w-4 h-4" />
              {item.label}
              {item.id === 'support' && unreadSupport > 0 && <span className="ml-auto bg-neutral-900 text-white text-xs rounded-full px-1.5 py-0.5">{unreadSupport}</span>}
            </button>
          ))}
        </nav>
        <div className="p-3 border-t border-neutral-200">
          <Link to="/" className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-neutral-600 hover:bg-neutral-50">
            <LayoutDashboard className="w-4 h-4" /> View Store
          </Link>
          <button
            onClick={async () => { await logout(); navigate('/'); }}
            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium text-neutral-600 hover:bg-neutral-50"
          >
            <LogOut className="w-4 h-4" />
            Logout
          </button>
        </div>
      </aside>

      {/* Mobile Header */}
      <div className="lg:hidden fixed top-0 left-0 right-0 z-40 bg-white border-b border-neutral-200 px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 bg-neutral-900 rounded-lg flex items-center justify-center">
              <span className="text-white font-bold text-xs">H</span>
            </div>
            <span className="font-semibold text-sm">Admin</span>
          </div>
          <select value={activeSection} onChange={e => setActiveSection(e.target.value)} className="text-sm border border-neutral-200 rounded-lg px-2 py-1.5">
            {navItems.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </div>
      </div>

      {/* Main Content */}
      <main className="flex-1 lg:ml-64 pt-16 lg:pt-0">
        <div className="p-4 sm:p-6 lg:p-8">
          {activeSection === 'overview' && <AdminOverview res={ordersRes} orders={orders} />}
          {activeSection === 'orders' && <AdminOrders res={ordersRes} orders={orders} />}
          {activeSection === 'products' && <AdminProducts />}
          {activeSection === 'customers' && <AdminCustomers />}
          {activeSection === 'payments' && <AdminPayments res={ordersRes} orders={orders} printpay={printpay} />}
          {activeSection === 'tips' && <AdminTips />}
          {activeSection === 'support' && <AdminSupport tickets={supportTickets} />}
          {activeSection === 'promotions' && <PromotionsPanel />}
          {activeSection === 'notifications' && <NotificationsPanel />}
          {activeSection === 'settings' && <DeliverySettings />}
        </div>
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Overview — real numbers from /api/admin/orders (+ low stock from the admin
// products API). No fake trends.
// ---------------------------------------------------------------------------
function AdminOverview({ res, orders }: { res: ReturnType<typeof useAdminData<any[]>>; orders: any[] }) {
  const productsRes = useAdminData<any[]>('/api/admin/products');
  const paid = orders.filter(o => o.paymentStatus === 'PAID');
  const revenue = paid.reduce((sum, o) => sum + (Number(o.total) || 0), 0);
  const pending = orders.filter(o => o.orderStatus === 'PENDING').length;
  const processing = orders.filter(o => o.orderStatus === 'PROCESSING').length;

  const lowStock = ((productsRes.data as any[]) || [])
    .filter(p => p.status === 'ACTIVE')
    .map(p => {
      const inventory = Array.isArray(p.inventory) ? p.inventory : [];
      const total = Number(p.stockQuantity) || inventory.reduce((s: number, i: any) => s + (Number(i.quantity) || 0), 0);
      return { ...p, total };
    })
    .filter(p => p.total <= 3)
    .slice(0, 5);

  return (
    <div className="space-y-6 animate-fadeIn">
      <div>
        <h1 className="text-2xl font-bold text-neutral-900">Dashboard</h1>
        <p className="text-sm text-neutral-500">Live data from the store.</p>
      </div>

      {res.loading && <LoadingCard />}
      {res.error && !res.loading && <ErrorCard message={res.error} onRetry={res.reload} />}

      {!res.loading && !res.error && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <StatCard title="Paid Revenue" value={money(revenue)} icon={TrendingUp} />
            <StatCard title="Total Orders" value={String(orders.length)} icon={ShoppingBag} />
            <StatCard title="Pending" value={String(pending)} icon={AlertTriangle} variant="warning" />
            <StatCard title="Processing" value={String(processing)} icon={Package} variant="info" />
          </div>

          <Card className="p-6">
            <div className="flex items-center justify-between mb-4">
              <h3 className="font-semibold text-neutral-900">Recent Orders</h3>
              <button onClick={() => res.reload()} className="text-sm text-neutral-600 hover:text-neutral-900">Refresh</button>
            </div>
            {orders.length === 0 ? (
              <EmptyState title="No orders yet" description="New orders will appear here." />
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="border-b border-neutral-200">
                    <tr>
                      <th className="text-left py-3 px-2 font-medium text-neutral-600">Order</th>
                      <th className="text-left py-3 px-2 font-medium text-neutral-600">Customer</th>
                      <th className="text-left py-3 px-2 font-medium text-neutral-600 hidden sm:table-cell">Date</th>
                      <th className="text-left py-3 px-2 font-medium text-neutral-600">Amount</th>
                      <th className="text-left py-3 px-2 font-medium text-neutral-600">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-100">
                    {orders.slice(0, 5).map(order => (
                      <tr key={order.id} className="hover:bg-neutral-50">
                        <td className="py-3 px-2 font-medium">{order.orderId}</td>
                        <td className="py-3 px-2 text-neutral-600">{order.customerName}</td>
                        <td className="py-3 px-2 text-neutral-500 hidden sm:table-cell">{day(order.createdAt)}</td>
                        <td className="py-3 px-2">{money(order.total)}</td>
                        <td className="py-3 px-2"><Badge variant={getStatusBadge(order.orderStatus).variant}>{getStatusBadge(order.orderStatus).label}</Badge></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </Card>

          <Card className="p-6">
            <h3 className="font-semibold text-neutral-900 mb-4">Low Stock Alerts</h3>
            {lowStock.length === 0 ? (
              <p className="text-sm text-neutral-500">No active product is low on stock.</p>
            ) : (
              <div className="space-y-3">
                {lowStock.map(p => (
                  <div key={p.id} className="flex items-center justify-between p-3 bg-amber-50 rounded-lg">
                    <div>
                      <p className="text-sm font-medium text-neutral-900">{p.name}</p>
                      <p className="text-xs text-neutral-500">{p.sku} · {p.total} left</p>
                    </div>
                    <Badge variant="warning">Low Stock</Badge>
                  </div>
                ))}
              </div>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Orders — GET /api/admin/orders, status change via PATCH /api/admin/orders.
// ---------------------------------------------------------------------------
function AdminOrders({ res, orders }: { res: ReturnType<typeof useAdminData<any>>; orders: any[] }) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [detailId, setDetailId] = useState<string | null>(null);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const filtered = orders.filter(o => {
    const text = `${o.orderId} ${o.invoiceNumber || ''} ${o.customerName || ''} ${o.customerEmail || ''}`.toLowerCase();
    return (!search || text.includes(search.toLowerCase())) && (!statusFilter || o.orderStatus === statusFilter);
  });
  const detail = detailId ? orders.find(o => o.id === detailId) ?? null : null;

  async function changeStatus(order: any, orderStatus: string) {
    setBusyId(order.id);
    setActionError(null);
    try {
      await apiFetch('/api/admin/orders', {
        method: 'PATCH',
        body: JSON.stringify({ orderDocumentId: order.id, orderStatus, note: '' }),
      });
      setToast(`Order ${order.orderId} moved to ${humanStatus(orderStatus)}.`);
      res.reload();
    } catch (err: any) {
      setActionError(err?.message || 'Could not update the order.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6 animate-fadeIn">
      <h1 className="text-2xl font-bold text-neutral-900">Orders</h1>
      <div className="flex flex-col sm:flex-row gap-3">
        <Input placeholder="Search orders…" value={search} onChange={e => setSearch(e.target.value)} className="flex-1" />
        <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} className="border border-neutral-200 rounded-lg px-3 py-2 text-sm bg-white">
          <option value="">All statuses</option>
          {ORDER_STATUSES.map(s => <option key={s} value={s}>{humanStatus(s)}</option>)}
        </select>
      </div>
      {actionError && <div role="alert" className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3">{actionError}</div>}
      {res.loading && <LoadingCard />}
      {res.error && !res.loading && <ErrorCard message={res.error} onRetry={res.reload} />}
      {!res.loading && !res.error && (
        <Card className="overflow-hidden">
          {filtered.length === 0 ? (
            <EmptyState title="No orders found" description="Orders will appear here once customers check out." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-neutral-50 border-b border-neutral-200">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium text-neutral-600">Order</th>
                    <th className="text-left px-4 py-3 font-medium text-neutral-600">Customer</th>
                    <th className="text-left px-4 py-3 font-medium text-neutral-600 hidden md:table-cell">Date</th>
                    <th className="text-left px-4 py-3 font-medium text-neutral-600">Total</th>
                    <th className="text-left px-4 py-3 font-medium text-neutral-600">Payment</th>
                    <th className="text-left px-4 py-3 font-medium text-neutral-600">Status</th>
                    <th className="text-right px-4 py-3 font-medium text-neutral-600">Change</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100">
                  {filtered.map(order => {
                    const next = nextOrderStatuses(order.orderStatus);
                    return (
                      <tr key={order.id} className="hover:bg-neutral-50 cursor-pointer" onClick={() => setDetailId(order.id)}>
                        <td className="px-4 py-3 font-medium">{order.orderId}
                          {order.invoiceNumber && (
                            <p className="text-xs font-normal text-neutral-500">Invoice {order.invoiceNumber}</p>
                          )}
                          {order.needsReview === true && (
                            <span title={order.needsReviewNote || 'Late payment after the reservation was released — check stock.'}
                              className="ml-2 inline-flex items-center rounded-full bg-amber-100 text-amber-800 border border-amber-300 px-2 py-0.5 text-[10px] font-semibold align-middle">
                              Needs review
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-neutral-600">
                          {order.customerName || order.delivery?.fullName || '—'}
                          <p className="text-xs text-neutral-400">{order.customerPhone}</p>
                        </td>
                        <td className="px-4 py-3 text-neutral-500 hidden md:table-cell">{day(order.createdAt)}</td>
                        <td className="px-4 py-3 font-medium">{money(order.total)}</td>
                        <td className="px-4 py-3"><Badge variant={getStatusBadge(order.paymentStatus).variant}>{getStatusBadge(order.paymentStatus).label}</Badge></td>
                        <td className="px-4 py-3"><Badge variant={getStatusBadge(order.orderStatus).variant}>{getStatusBadge(order.orderStatus).label}</Badge></td>
                        <td className="px-4 py-3 text-right whitespace-nowrap" onClick={e => e.stopPropagation()}>
                          <select
                            value=""
                            disabled={busyId === order.id || next.length === 0}
                            title={next.length === 0 ? 'No further status changes allowed' : undefined}
                            onChange={e => e.target.value && changeStatus(order, e.target.value)}
                            className="border border-neutral-200 rounded-lg px-2 py-1.5 text-xs bg-white disabled:opacity-50"
                          >
                            <option value="">{busyId === order.id ? 'Saving…' : next.length === 0 ? 'Final' : 'Update status'}</option>
                            {next.map(s => (
                              <option key={s} value={s}>{humanStatus(s)}</option>
                            ))}
                          </select>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
      {!res.loading && !res.error && orders.length % 100 === 0 && orders.length > 0 && (
        <div className="flex justify-center">
          <Button
            variant="outline"
            size="sm"
            disabled={res.loadingMore}
            onClick={() => {
              const last = orders[orders.length - 1];
              const c = last?.createdAt ?? last?.id;
              if (c) void res.loadMore?.(c);
            }}
          >
            {res.loadingMore ? 'Loading…' : 'Load more'}
          </Button>
        </div>
      )}
      {detail && <OrderDetailPanel order={detail} onClose={() => setDetailId(null)} />}
      {toast && <Toast message={toast} />}
    </div>
  );
}

// Invoice actions for PAID orders in the admin detail panel: download the PDF
// and resend the invoice email. Success/error messages are inline — no
// alert/confirm/popups.
function AdminInvoiceActions({ order }: { order: any }) {
  const [busyDl, setBusyDl] = useState(false);
  const [busySend, setBusySend] = useState(false);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const invoiceNumber = String(order.invoiceNumber || '').trim()
    || String(order.orderId || '').replace(/^HS-/, 'INV-');
  const download = async () => {
    setBusyDl(true); setMsg(null);
    try {
      await apiDownload(
        `/api/invoices/download?orderDocumentId=${encodeURIComponent(String(order.id))}`,
        `HerStep-Invoice-${invoiceNumber}.pdf`,
      );
      setMsg({ kind: 'ok', text: 'Invoice downloaded.' });
    } catch (e: any) {
      setMsg({ kind: 'err', text: e?.message || 'We could not download the invoice.' });
    } finally { setBusyDl(false); }
  };
  const resend = async () => {
    setBusySend(true); setMsg(null);
    try {
      // Backend returns { queued, sent, to?, reason? } — "sent" reflects the
      // best-effort delivery attempt right after queueing, so the admin sees
      // whether the invoice email actually went out (or why it did not).
      const out = await apiFetch('/api/admin/invoices/resend', {
        method: 'POST',
        body: JSON.stringify({ orderDocumentId: String(order.id) }),
      }) as any;
      if (out?.sent === true) {
        setMsg({ kind: 'ok', text: `Invoice email sent to ${String(out.to || order.customerEmail || 'the customer')}` });
      } else if (out?.queued === true) {
        setMsg({ kind: 'err', text: String(out?.reason || 'The invoice email was queued but could not be delivered yet.') });
      } else {
        setMsg({ kind: 'err', text: 'We could not resend the invoice email.' });
      }
    } catch (e: any) {
      setMsg({ kind: 'err', text: e?.message || 'We could not resend the invoice email.' });
    } finally { setBusySend(false); }
  };
  return (
    <div className="pt-2">
      <div className="flex flex-wrap gap-3">
        <Button variant="outline" size="sm" onClick={download} disabled={busyDl}>
          <FileText className="w-4 h-4 mr-2" />
          {busyDl ? 'Preparing…' : `Download invoice ${invoiceNumber}`}
        </Button>
        <Button variant="outline" size="sm" onClick={resend} disabled={busySend}>
          {busySend ? 'Sending…' : 'Resend invoice email'}
        </Button>
      </div>
      {msg && <p role="alert" className={`text-xs mt-2 ${msg.kind === 'ok' ? 'text-emerald-700' : 'text-red-600'}`}>{msg.text}</p>}
    </div>
  );
}

// Order detail panel — everything the customer ordered plus delivery notes and
// the full status-history timeline. Names and HS order numbers only, never ids.
function OrderDetailPanel({ order, onClose }: { order: any; onClose: () => void }) {
  const history = Array.isArray(order.history) ? order.history : [];
  const items = Array.isArray(order.items) ? order.items : [];
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-6" role="dialog" aria-modal="true">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white w-full max-w-2xl max-h-[90vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl shadow-xl">
        <div className="sticky top-0 bg-white border-b border-neutral-200 px-6 py-4 flex items-center justify-between">
          <div>
            <h2 className="text-lg font-bold text-neutral-900">Order {order.orderId}</h2>
            <p className="text-xs text-neutral-500">Placed {day(order.createdAt)} · {order.customerName || order.delivery?.fullName || '—'}</p>
          </div>
          <button onClick={onClose} aria-label="Close" className="p-2 rounded-full hover:bg-neutral-100"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-6 space-y-6">
          <div className="grid grid-cols-2 gap-3 text-sm">
            <div><p className="text-neutral-500">Order status</p><Badge variant={getStatusBadge(order.orderStatus).variant}>{getStatusBadge(order.orderStatus).label}</Badge></div>
            <div><p className="text-neutral-500">Payment status</p><Badge variant={getStatusBadge(order.paymentStatus).variant}>{getStatusBadge(order.paymentStatus).label}</Badge></div>
            {order.needsReview === true && (
              <div className="col-span-2 bg-amber-50 border border-amber-300 text-amber-800 rounded-lg px-3 py-2 text-xs font-semibold">
                Needs review{order.needsReviewNote ? ` — ${order.needsReviewNote}` : ' — payment arrived after the stock reservation was released; verify availability before fulfilment.'}
              </div>
            )}
            {order.receiptNumber && <div><p className="text-neutral-500">M-Pesa receipt</p><p className="font-mono text-xs">{order.receiptNumber}</p></div>}
            {order.paymentReference && <div><p className="text-neutral-500">Payment reference</p><p className="font-mono text-xs">{order.paymentReference}</p></div>}
            {order.failureReason && <div className="col-span-2 bg-red-50 border border-red-200 text-red-700 rounded-lg px-3 py-2 text-xs">{order.failureReason}</div>}
          </div>

          <div>
            <h3 className="text-sm font-semibold text-neutral-900 mb-2">Items</h3>
            <div className="border border-neutral-200 rounded-lg divide-y divide-neutral-100">
              {items.map((i: any, n: number) => (
                <div key={n} className="flex items-center gap-3 px-3 py-2 text-sm">
                  <img src={i.imageUrl || undefined} alt={i.name} onError={handleImageError} className="w-10 h-10 rounded object-cover bg-neutral-100" />
                  <div className="flex-1 min-w-0">
                    <p className="truncate font-medium text-neutral-900">{i.name}</p>
                    <p className="text-xs text-neutral-500">Size {i.size} · Qty {i.quantity} × {money(i.unitPrice)}</p>
                  </div>
                  <p className="font-medium">{money(i.lineTotal)}</p>
                </div>
              ))}
              {items.length === 0 && <p className="px-3 py-2 text-sm text-neutral-500">No item details stored on this order.</p>}
            </div>
          </div>

          <div className="text-sm space-y-1">
            <div className="flex justify-between"><span className="text-neutral-500">Subtotal</span><span>{money(order.subtotal)}</span></div>
            <div className="flex justify-between"><span className="text-neutral-500">Delivery fee</span><span>{money(order.deliveryFee)}</span></div>
            <div className="flex justify-between"><span className="text-neutral-500">Discount</span><span>{money(order.discount)}</span></div>
            <div className="flex justify-between font-bold text-neutral-900 border-t border-neutral-200 pt-2"><span>Total</span><span>{money(order.total)}</span></div>
          </div>

          {String(order.paymentStatus).toUpperCase() === 'PAID' && (
            <AdminInvoiceActions order={order} />
          )}

          <div>
            <h3 className="text-sm font-semibold text-neutral-900 mb-2">Delivery</h3>
            <div className="text-sm space-y-1 text-neutral-700">
              <p><span className="text-neutral-500">Method:</span> {humanStatus(order.delivery?.deliveryMethod) || '—'}</p>
              <p><span className="text-neutral-500">Name:</span> {order.delivery?.fullName || '—'}</p>
              <p><span className="text-neutral-500">Phone:</span> {order.delivery?.phone || '—'}</p>
              {order.delivery?.location && <p><span className="text-neutral-500">Location:</span> {order.delivery.location}</p>}
              {order.customerEmail && <p><span className="text-neutral-500">Email:</span> {order.customerEmail}</p>}
              {order.delivery?.instructions && (
                <p className="bg-amber-50 border border-amber-200 rounded-lg px-3 py-2 text-amber-800">
                  <span className="font-medium">Delivery notes:</span> {order.delivery.instructions}
                </p>
              )}
            </div>
          </div>

          <div>
            <h3 className="text-sm font-semibold text-neutral-900 mb-2">Status history</h3>
            {history.length === 0 ? (
              <p className="text-sm text-neutral-500">No history recorded yet.</p>
            ) : (
              <ol className="space-y-3">
                {history.map((h: any, n: number) => (
                  <li key={n} className="flex gap-3 text-sm">
                    <span className="mt-1 w-2 h-2 rounded-full bg-neutral-300 shrink-0" />
                    <div>
                      <p className="font-medium text-neutral-900">
                        {h.previousStatus ? `${humanStatus(h.previousStatus)} → ${humanStatus(h.newStatus)}` : humanStatus(h.newStatus)}
                      </p>
                      {h.note && <p className="text-neutral-500 text-xs">{h.note}</p>}
                      <p className="text-neutral-400 text-xs">{day(h.createdAt)}{h.source ? ` · ${String(h.source).toLowerCase()}` : ''}</p>
                    </div>
                  </li>
                ))}
              </ol>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}


// ---------------------------------------------------------------------------
// Products — GET /api/admin/products (ALL statuses) with category names from
// GET /api/categories, plus a working Add/Edit form and Archive button.
// ---------------------------------------------------------------------------
type ImageAsset = { url: string; publicId: string; resourceType: 'image' };

function emptyForm() {
  return {
    name: '',
    description: '',
    categoryId: '',
    sku: '',
    price: '',
    salePrice: '',
    quantities: {} as Record<string, string>, // size -> qty string
    images: [] as ImageAsset[],
    video: null as { url: string; publicId: string; resourceType: 'video' } | null,
    status: 'DRAFT',
    featured: false,
    bestseller: false,
    newArrival: false,
  };
}

function AdminProducts() {
  const productsRes = useAdminData<any[]>('/api/admin/products');
  const categoriesRes = useAdminData<any[]>('/api/categories');
  const categories = useMemo(() => (Array.isArray(categoriesRes.data) ? categoriesRes.data : []), [categoriesRes.data]);
  const categoryName = useCallback(
    (id: string) => categories.find(c => c.id === id)?.name || id || '—',
    [categories],
  );
  const [editing, setEditing] = useState<null | { id: string | null }>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [listError, setListError] = useState<string | null>(null);

  async function archive(id: string) {
    if (!window.confirm('Archive this product? It disappears from the shop.')) return;
    setBusyId(id);
    setListError(null);
    try {
      await apiFetch(`/api/admin/products/${id}/archive`, { method: 'POST' });
      productsRes.reload();
    } catch (err: any) {
      setListError(err?.message || 'Could not archive the product.');
    } finally {
      setBusyId(null);
    }
  }

  return (
    <div className="space-y-6 animate-fadeIn">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-neutral-900">Products</h1>
        <Button onClick={() => setEditing({ id: null })}>Add Product</Button>
      </div>
      {listError && <div role="alert" className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3">{listError}</div>}
      {productsRes.loading && <LoadingCard />}
      {productsRes.error && !productsRes.loading && <ErrorCard message={productsRes.error} onRetry={productsRes.reload} />}
      {!productsRes.loading && !productsRes.error && (
        <Card className="overflow-hidden">
          {(productsRes.data || []).length === 0 ? (
            <EmptyState title="No products yet" description="Create your first product to fill the shop." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-neutral-50 border-b border-neutral-200">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium text-neutral-600">Product</th>
                    <th className="text-left px-4 py-3 font-medium text-neutral-600 hidden sm:table-cell">SKU</th>
                    <th className="text-left px-4 py-3 font-medium text-neutral-600">Category</th>
                    <th className="text-left px-4 py-3 font-medium text-neutral-600">Price</th>
                    <th className="text-left px-4 py-3 font-medium text-neutral-600 hidden md:table-cell">Stock</th>
                    <th className="text-left px-4 py-3 font-medium text-neutral-600">Status</th>
                    <th className="text-right px-4 py-3 font-medium text-neutral-600">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100">
                  {(productsRes.data || []).map((p: any) => {
                    const inventory = Array.isArray(p.inventory) ? p.inventory : [];
                    const totalStock = Number(p.stockQuantity ?? inventory.reduce((s: number, i: any) => s + (Number(i.quantity) || 0), 0));
                    const discounted = p.salePrice != null && p.salePrice > 0 && p.salePrice < p.price;
                    return (
                      <tr key={p.id} className="hover:bg-neutral-50">
                        <td className="px-4 py-3">
                          <div className="flex items-center gap-3">
                            <img src={productImageUrl(p)} onError={handleImageError} alt="" className="w-10 h-10 rounded-lg object-cover bg-neutral-100" />
                            <div>
                              <p className="font-medium text-neutral-900">{p.name}</p>
                              <div className="flex gap-2 mt-0.5">
                                {p.featured && <span className="text-[10px] uppercase text-neutral-500">Featured</span>}
                                {p.bestseller && <span className="text-[10px] uppercase text-neutral-500">Bestseller</span>}
                                {p.newArrival && <span className="text-[10px] uppercase text-neutral-500">New</span>}
                              </div>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3 text-neutral-500 font-mono text-xs hidden sm:table-cell">{p.sku}</td>
                        <td className="px-4 py-3 text-neutral-600">{categoryName(p.categoryId)}</td>
                        <td className="px-4 py-3">
                          {discounted ? (
                            <div>
                              <span className="font-medium">{money(p.salePrice)}</span>
                              <span className="text-xs text-neutral-400 line-through ml-1">{money(p.price)}</span>
                            </div>
                          ) : money(p.price)}
                        </td>
                        <td className="px-4 py-3 hidden md:table-cell">
                          <span className={totalStock <= 3 ? 'text-amber-600 font-medium' : 'text-neutral-900'}>{totalStock}</span>
                        </td>
                        <td className="px-4 py-3">
                          <Badge variant={p.status === 'ACTIVE' ? 'success' : p.status === 'ARCHIVED' ? 'danger' : 'default'}>{p.status}</Badge>
                        </td>
                        <td className="px-4 py-3 text-right whitespace-nowrap">
                          <Button variant="ghost" size="sm" onClick={() => setEditing({ id: p.id })}>Edit</Button>
                          <Button variant="ghost" size="sm" disabled={busyId === p.id} onClick={() => archive(p.id)}>
                            {busyId === p.id ? '…' : 'Archive'}
                          </Button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
      {editing && (
        <ProductFormModal
          editId={editing.id}
          product={(productsRes.data || []).find((p: any) => p.id === editing.id) || null}
          categories={categories}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); productsRes.reload(); }}
        />
      )}
    </div>
  );
}

// Client-side mirror of validateProduct in api/_lib/routes/admin-products.js.
function validateProductForm(form: ReturnType<typeof emptyForm>): string | null {
  if (!form.name.trim() || form.name.trim().length > 160) return 'Enter a product name of 160 characters or fewer.';
  if (form.description.length > 4000) return 'Description must be 4,000 characters or fewer.';
  if (!form.categoryId) return 'Select a category.';
  if (!/^[A-Z0-9_-]{1,80}$/.test(form.sku)) return 'SKU must be uppercase letters, numbers, - or _ (max 80).';
  const price = Number(form.price);
  if (!Number.isInteger(price) || price < 0) return 'Price must be a non-negative whole number.';
  if (form.salePrice !== '') {
    const salePrice = Number(form.salePrice);
    if (!Number.isInteger(salePrice) || salePrice >= price) return 'Sale price must be a whole number lower than the price.';
  }
  const inventory = Object.entries(form.quantities)
    .filter(([size, q]) => SIZES.includes(size) && q !== '')
    .map(([size, q]) => ({ size, quantity: Number(q) }))
    .filter(i => Number.isInteger(i.quantity) && i.quantity >= 0);
  if (inventory.length < 1) return 'Add stock for at least one size.';
  if (form.images.length < 1 || form.images.length > 8) return 'Provide between one and eight images.';
  if (!['DRAFT', 'ACTIVE', 'ARCHIVED'].includes(form.status)) return 'Product status is invalid.';
  return null;
}

function ProductFormModal({ editId, product, categories, onClose, onSaved }: {
  editId: string | null;
  product: any;
  categories: any[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [form, setForm] = useState<ReturnType<typeof emptyForm>>(() => {
    if (!product) return emptyForm();
    const quantities: Record<string, string> = {};
    (Array.isArray(product.inventory) ? product.inventory : []).forEach((i: any) => { quantities[String(i.size)] = String(i.quantity ?? 0); });
    return {
      name: product.name || '',
      description: product.description || '',
      categoryId: product.categoryId || '',
      sku: product.sku || '',
      price: String(product.price ?? ''),
      salePrice: product.salePrice == null ? '' : String(product.salePrice),
      quantities,
      images: Array.isArray(product.images) ? product.images : [],
      video: product.video || null,
      status: product.status || 'DRAFT',
      featured: !!product.featured,
      bestseller: !!product.bestseller,
      newArrival: !!product.newArrival,
    };
  });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);

  async function uploadFiles(files: FileList, kind: 'image' | 'video') {
    setUploading(true);
    setError(null);
    try {
      for (const file of Array.from(files)) {
        const sign = await apiFetch('/api/media/sign-upload', {
          method: 'POST',
          body: JSON.stringify({ resourceType: kind, fileName: file.name, bytes: file.size, purpose: 'products' }),
        });
        const fd = new FormData();
        fd.append('file', file);
        fd.append('api_key', sign.apiKey);
        fd.append('timestamp', String(sign.timestamp));
        fd.append('signature', sign.signature);
        fd.append('folder', sign.folder);
        fd.append('public_id', sign.publicId);
        const endpoint = `https://api.cloudinary.com/v1_1/${sign.cloudName}/${kind}/upload`;
        const uploaded = await fetch(endpoint, { method: 'POST', body: fd }).then(async r => {
          const text = await r.text();
          let json: any = {};
          try { json = JSON.parse(text); } catch { /* non-JSON error page */ }
          if (!r.ok) throw new Error(json?.error?.message || 'The upload failed.');
          return json;
        });
        const asset = { url: String(uploaded.secure_url), publicId: String(uploaded.public_id), resourceType: kind };
        if (kind === 'image') setForm(f => ({ ...f, images: [...f.images, { ...asset, resourceType: 'image' as const }].slice(0, 8) }));
        else setForm(f => ({ ...f, video: asset as any }));
      }
    } catch (err: any) {
      setError(err?.message || 'Upload failed.');
    } finally {
      setUploading(false);
    }
  }

  async function save() {
    const clientError = validateProductForm(form);
    if (clientError) { setError(clientError); return; }
    const inventory = Object.entries(form.quantities)
      .filter(([size, q]) => SIZES.includes(size) && q !== '')
      .map(([size, q]) => ({ size, quantity: Number(q) }))
      .filter(i => Number.isInteger(i.quantity) && i.quantity >= 0);
    const payload: Record<string, any> = {
      name: form.name.trim(),
      description: form.description,
      categoryId: form.categoryId,
      sku: form.sku.toUpperCase(),
      price: Number(form.price),
      salePrice: form.salePrice === '' ? null : Number(form.salePrice),
      inventory,
      images: form.images,
      video: form.video,
      status: form.status,
      featured: form.featured,
      bestseller: form.bestseller,
      newArrival: form.newArrival,
    };
    setSaving(true);
    setError(null);
    try {
      if (editId) await apiFetch(`/api/admin/products/${editId}`, { method: 'PUT', body: JSON.stringify(payload) });
      else await apiFetch('/api/admin/products', { method: 'POST', body: JSON.stringify(payload) });
      onSaved();
    } catch (err: any) {
      setError(err?.message || 'The server rejected the product.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-start justify-center overflow-y-auto p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-2xl my-8" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-neutral-200 sticky top-0 bg-white rounded-t-xl">
          <h2 className="font-semibold text-neutral-900">{editId ? 'Edit Product' : 'Add Product'}</h2>
          <button onClick={onClose} aria-label="Close" className="p-1 rounded hover:bg-neutral-100"><X className="w-5 h-5 text-neutral-500" /></button>
        </div>
        <div className="p-6 space-y-4">
          {error && <div role="alert" className="bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg px-4 py-3">{error}</div>}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <Input label="Name" value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} />
            <Input label="SKU (auto-uppercased)" value={form.sku} onChange={e => setForm(f => ({ ...f, sku: e.target.value.toUpperCase() }))} />
          </div>
          <div>
            <label className="block text-sm font-medium text-neutral-700 mb-1">Description</label>
            <textarea rows={3} value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              className="w-full border border-neutral-200 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-neutral-900" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1">Category</label>
              <select value={form.categoryId} onChange={e => setForm(f => ({ ...f, categoryId: e.target.value }))}
                className="w-full border border-neutral-200 rounded-lg px-3 py-2 text-sm bg-white">
                <option value="">Select…</option>
                {categories.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <Input label="Price (KSh)" type="number" value={form.price} onChange={e => setForm(f => ({ ...f, price: e.target.value }))} />
            <Input label="Sale price (optional, lower than price)" type="number" value={form.salePrice} onChange={e => setForm(f => ({ ...f, salePrice: e.target.value }))} />
          </div>

          <div>
            <label className="block text-sm font-medium text-neutral-700 mb-2">Sizes &amp; stock (30–45)</label>
            <div className="grid grid-cols-4 sm:grid-cols-8 gap-2">
              {SIZES.map(size => (
                <div key={size} className="flex flex-col items-center gap-1">
                  <span className="text-xs text-neutral-500">{size}</span>
                  <input
                    inputMode="numeric"
                    placeholder="0"
                    value={form.quantities[size] ?? ''}
                    onChange={e => setForm(f => ({ ...f, quantities: { ...f.quantities, [size]: e.target.value.replace(/[^\d]/g, '') } }))}
                    className="w-full border border-neutral-200 rounded-lg px-1 py-1.5 text-sm text-center"
                  />
                </div>
              ))}
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm font-medium text-neutral-700">Images ({form.images.length}/8)</label>
              <label className={`inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border border-neutral-200 cursor-pointer ${uploading ? 'opacity-50 pointer-events-none' : 'hover:bg-neutral-50'}`}>
                <Upload className="w-4 h-4" /> Upload image
                <input type="file" accept="image/*" multiple className="hidden" onChange={e => e.target.files && uploadFiles(e.target.files, 'image')} />
              </label>
            </div>
            <div className="flex flex-wrap gap-2">
              {form.images.map((img, idx) => (
                <div key={img.publicId || idx} className="relative">
                  <img src={img.url} onError={handleImageError} alt="" className="w-16 h-16 rounded-lg object-cover bg-neutral-100" />
                  <button
                    onClick={() => setForm(f => ({ ...f, images: f.images.filter((_, n) => n !== idx) }))}
                    className="absolute -top-1.5 -right-1.5 bg-neutral-900 text-white rounded-full p-0.5" aria-label="Remove image"
                  ><X className="w-3 h-3" /></button>
                </div>
              ))}
              {form.images.length === 0 && <p className="text-xs text-neutral-400">At least one image is required.</p>}
            </div>
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="block text-sm font-medium text-neutral-700">Video (optional)</label>
              <label className={`inline-flex items-center gap-1.5 text-sm px-3 py-1.5 rounded-lg border border-neutral-200 cursor-pointer ${uploading ? 'opacity-50 pointer-events-none' : 'hover:bg-neutral-50'}`}>
                <Upload className="w-4 h-4" /> Upload video
                <input type="file" accept="video/*" className="hidden" onChange={e => e.target.files && uploadFiles(e.target.files, 'video')} />
              </label>
            </div>
            {form.video ? (
              <div className="flex items-center gap-2 text-xs text-neutral-600">
                <video src={form.video.url} className="w-24 h-16 rounded object-cover bg-neutral-100" controls={false} />
                <button onClick={() => setForm(f => ({ ...f, video: null }))} className="text-red-600">Remove</button>
              </div>
            ) : <p className="text-xs text-neutral-400">No video uploaded.</p>}
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 items-end">
            <div>
              <label className="block text-sm font-medium text-neutral-700 mb-1">Status</label>
              <select value={form.status} onChange={e => setForm(f => ({ ...f, status: e.target.value }))}
                className="w-full border border-neutral-200 rounded-lg px-3 py-2 text-sm bg-white">
                {['DRAFT', 'ACTIVE', 'ARCHIVED'].map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            {([['featured', 'Featured'], ['bestseller', 'Bestseller'], ['newArrival', 'New arrival']] as const).map(([key, label]) => (
              <label key={key} className="flex items-center gap-2 text-sm text-neutral-700 pb-2">
                <input type="checkbox" checked={form[key]} onChange={e => setForm(f => ({ ...f, [key]: e.target.checked }))} />
                {label}
              </label>
            ))}
          </div>
        </div>
        <div className="flex justify-end gap-3 px-6 py-4 border-t border-neutral-200 sticky bottom-0 bg-white rounded-b-xl">
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={save} disabled={saving || uploading}>{saving ? 'Saving…' : editId ? 'Save changes' : 'Create product'}</Button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Customers — GET /api/admin/customers (real users + PAID-order stats).
// ---------------------------------------------------------------------------
function AdminCustomers() {
  const res = useAdminData<any[]>('/api/admin/customers');
  const rows = Array.isArray(res.data) ? res.data : [];
  return (
    <div className="space-y-6 animate-fadeIn">
      <h1 className="text-2xl font-bold text-neutral-900">Customers</h1>
      {res.loading && <LoadingCard />}
      {res.error && !res.loading && <ErrorCard message={res.error} onRetry={res.reload} />}
      {!res.loading && !res.error && (
        <Card className="overflow-hidden">
          {rows.length === 0 ? (
            <EmptyState title="No customers yet" description="Registered customers will appear here." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-neutral-50 border-b border-neutral-200">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium text-neutral-600">Customer</th>
                    <th className="text-left px-4 py-3 font-medium text-neutral-600 hidden sm:table-cell">Phone</th>
                    <th className="text-left px-4 py-3 font-medium text-neutral-600">Role</th>
                    <th className="text-left px-4 py-3 font-medium text-neutral-600">Paid Orders</th>
                    <th className="text-left px-4 py-3 font-medium text-neutral-600">Total Spent</th>
                    <th className="text-left px-4 py-3 font-medium text-neutral-600 hidden md:table-cell">Joined</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100">
                  {rows.map(c => (
                    <tr key={c.uid} className="hover:bg-neutral-50">
                      <td className="px-4 py-3">
                        <p className="font-medium text-neutral-900">{c.displayName || '—'}</p>
                        <p className="text-xs text-neutral-500">{c.email || 'no email'}</p>
                      </td>
                      <td className="px-4 py-3 text-neutral-600 hidden sm:table-cell">{c.phoneNumber || '—'}</td>
                      <td className="px-4 py-3"><Badge variant={c.role === 'CUSTOMER' ? 'default' : 'info'}>{c.role}</Badge></td>
                      <td className="px-4 py-3">{c.orderCount}</td>
                      <td className="px-4 py-3 font-medium">{money(c.totalSpent)}</td>
                      <td className="px-4 py-3 text-neutral-500 hidden md:table-cell">{day(c.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Payments — derived from GET /api/admin/orders (paymentStatus + reference).
// ---------------------------------------------------------------------------
function AdminPayments({ res, orders, printpay }: { res: ReturnType<typeof useAdminData<any>>; orders: any[]; printpay: any }) {
  const payOrders = orders.filter(o => o.paymentStatus || o.paymentReference || o.receiptNumber);
  return (
    <div className="space-y-6 animate-fadeIn">
      <h1 className="text-2xl font-bold text-neutral-900">Payments</h1>
      <PrintpayCallbackBanner printpay={printpay} />
      {res.loading && <LoadingCard />}
      {res.error && !res.loading && <ErrorCard message={res.error} onRetry={res.reload} />}
      {!res.loading && !res.error && (
        <Card className="overflow-hidden">
          {payOrders.length === 0 ? (
            <EmptyState title="No payments yet" description="M-Pesa payments will appear here." />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-neutral-50 border-b border-neutral-200">
                  <tr>
                    <th className="text-left px-4 py-3 font-medium text-neutral-600">Order</th>
                    <th className="text-left px-4 py-3 font-medium text-neutral-600">Customer</th>
                    <th className="text-left px-4 py-3 font-medium text-neutral-600 hidden sm:table-cell">Phone</th>
                    <th className="text-left px-4 py-3 font-medium text-neutral-600">Amount</th>
                    <th className="text-left px-4 py-3 font-medium text-neutral-600">Status</th>
                    <th className="text-left px-4 py-3 font-medium text-neutral-600">M-Pesa Receipt</th>
                    <th className="text-left px-4 py-3 font-medium text-neutral-600 hidden md:table-cell">Failure reason</th>
                    <th className="text-left px-4 py-3 font-medium text-neutral-600 hidden sm:table-cell">Date</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-neutral-100">
                  {payOrders.map(order => (
                    <tr key={order.id} className="hover:bg-neutral-50">
                      <td className="px-4 py-3 font-medium">{order.orderId}</td>
                      <td className="px-4 py-3 text-neutral-600">{order.customerName || order.delivery?.fullName || '—'}</td>
                      <td className="px-4 py-3 text-neutral-500 hidden sm:table-cell">{order.customerPhone || order.delivery?.phone || '—'}</td>
                      <td className="px-4 py-3 font-medium">{money(order.total)}</td>
                      <td className="px-4 py-3"><Badge variant={getStatusBadge(order.paymentStatus).variant}>{getStatusBadge(order.paymentStatus).label}</Badge></td>
                      <td className="px-4 py-3 text-neutral-500 font-mono text-xs">{order.receiptNumber || order.paymentReference || '—'}</td>
                      <td className="px-4 py-3 text-red-600 text-xs hidden md:table-cell">{order.failureReason || '—'}</td>
                      <td className="px-4 py-3 text-neutral-500 hidden sm:table-cell">{day(order.createdAt)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tips — GET /api/admin/tips (in-app tipping). Same table styling as Payments.
// Totals come ONLY from PAID tips (computed server-side in tip-core).
// ---------------------------------------------------------------------------
function AdminTips() {
  const res = useAdminData<any>('/api/admin/tips');
  const TREAT_LABELS: Record<string, string> = { SODA: 'Soda', COFFEE: 'Coffee', TEA: 'Tea', SNACK: 'Snack', TIP: 'Just a tip' };
  if (res.loading) return <LoadingCard />;
  if (res.error || !res.data) return <ErrorCard message={res.error || 'Could not load tips.'} onRetry={res.reload} />;
  const tips: any[] = res.data.tips || [];
  const totals = res.data.totals || { today: 0, thisMonth: 0, allTime: 0, paidCount: 0 };
  return (
    <div className="space-y-6 animate-fadeIn">
      <h1 className="text-2xl font-bold text-neutral-900">Tips</h1>
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
        <StatCard title="Today" value={money(totals.today)} icon={Heart} />
        <StatCard title="This month" value={money(totals.thisMonth)} icon={TrendingUp} />
        <StatCard title="All time" value={money(totals.allTime)} icon={CreditCard} />
        <StatCard title="Number of tips" value={String(totals.paidCount)} icon={Tag} variant="info" />
      </div>
      <Card className="overflow-hidden">
        {tips.length === 0 ? (
          <EmptyState title="No tips yet" description="Tips from customers will appear here." />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-neutral-50 border-b border-neutral-200">
                <tr>
                  <th className="text-left px-4 py-3 font-medium text-neutral-600">Tip</th>
                  <th className="text-left px-4 py-3 font-medium text-neutral-600">Customer</th>
                  <th className="text-left px-4 py-3 font-medium text-neutral-600 hidden sm:table-cell">Phone</th>
                  <th className="text-left px-4 py-3 font-medium text-neutral-600">Treat</th>
                  <th className="text-left px-4 py-3 font-medium text-neutral-600">Amount</th>
                  <th className="text-left px-4 py-3 font-medium text-neutral-600">Status</th>
                  <th className="text-left px-4 py-3 font-medium text-neutral-600">Receipt</th>
                  <th className="text-left px-4 py-3 font-medium text-neutral-600 hidden md:table-cell">Message</th>
                  <th className="text-left px-4 py-3 font-medium text-neutral-600 hidden sm:table-cell">Date</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-100">
                {tips.map(tip => (
                  <tr key={tip.tipId} className="hover:bg-neutral-50">
                    <td className="px-4 py-3 font-mono text-xs">{tip.tipId}</td>
                    <td className="px-4 py-3 text-neutral-600">{tip.customerName || '—'}</td>
                    <td className="px-4 py-3 text-neutral-500 hidden sm:table-cell">{tip.phone ? `••• ${tip.phone}` : '—'}</td>
                    <td className="px-4 py-3 text-neutral-600">{TREAT_LABELS[tip.treat] || tip.treat}</td>
                    <td className="px-4 py-3 font-medium">{money(tip.amount)}</td>
                    <td className="px-4 py-3"><Badge variant={getStatusBadge(tip.status).variant}>{getStatusBadge(tip.status).label}</Badge></td>
                    <td className="px-4 py-3 text-neutral-500 font-mono text-xs">{tip.receiptNumber || '—'}</td>
                    <td className="px-4 py-3 text-neutral-500 text-xs hidden md:table-cell max-w-[200px] truncate">{tip.message || '—'}</td>
                    <td className="px-4 py-3 text-neutral-500 hidden sm:table-cell">{day(tip.createdAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

function StatCard({ title, value, icon: Icon, trend, variant }: { title: string; value: string; icon?: any; trend?: string; variant?: string }) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between mb-2">
        <p className="text-xs text-neutral-500">{title}</p>
        {Icon && <Icon className="w-4 h-4 text-neutral-400" />}
      </div>
      <p className="text-2xl font-bold text-neutral-900">{value}</p>
      {trend && <p className="text-xs text-emerald-600 mt-1">{trend}</p>}
    </Card>
  );
}
