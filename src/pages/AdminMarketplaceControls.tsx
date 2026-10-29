import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowLeft, RefreshCw, Star, EyeOff, RotateCcw } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { usePageMeta } from '../hooks/usePageMeta';
import { Button, Card, Input } from '../components/ui';

export default function AdminMarketplaceControls() {
  usePageMeta('Marketplace Controls | HerStep Operations', 'Manage seller plans and marketplace products.');
  const [data,setData] = useState<any>({sellers:[],products:[]});
  const [sellerUid,setSellerUid] = useState('');
  const [planCode,setPlanCode] = useState('STANDARD');
  const [days,setDays] = useState('30');
  const [search,setSearch] = useState('');
  const [reason,setReason] = useState('');
  const [busy,setBusy] = useState('');
  const [error,setError] = useState('');
  const [notice,setNotice] = useState('');
  const [termDiscounts,setTermDiscounts] = useState<any>({1:0,3:5,6:10,12:20});
  const load = async () => { try { setData(await apiFetch('/api/admin/marketplace-controls')); setError(''); } catch(e:any) { setError(e?.message || 'Could not load records.'); } };
  useEffect(()=>{ void load(); },[]);
  const run = async (key:string, body:any) => { setBusy(key); setError(''); setNotice(''); try { const r:any=await apiFetch('/api/admin/marketplace-controls',{method:'PATCH',body:JSON.stringify({...body,reason})}); setNotice(r.message || 'Saved.'); await load(); } catch(e:any) { setError(e?.message || 'Could not save.'); } finally { setBusy(''); } };
  const products = (data.products || []).filter((p:any)=>(p.name+' '+p.sellerBusinessName+' '+p.sellerUid).toLowerCase().includes(search.toLowerCase()));
  const selected = (data.sellers || []).find((s:any)=>s.uid===sellerUid);
  return <div className="min-h-screen bg-neutral-50"><div className="max-w-6xl mx-auto px-4 py-8">
    <Link to="/admin" className="inline-flex items-center gap-2 text-sm text-neutral-500 mb-5"><ArrowLeft className="w-4 h-4"/> Back to admin</Link>
    <div className="flex justify-between gap-4 mb-6"><div><h1 className="text-3xl font-bold">Marketplace controls</h1><p className="text-sm text-neutral-600 mt-2">Assign or revoke seller plans, promote listings, and hide or restore products.</p></div><Button variant="outline" onClick={load}><RefreshCw className="w-4 h-4 mr-2"/> Refresh</Button></div>
    {error && <p role="alert" className="bg-red-50 text-red-700 rounded p-3 mb-4">{error}</p>}{notice && <p role="status" className="bg-green-50 text-green-700 rounded p-3 mb-4">{notice}</p>}
    <Card className="p-5 mb-7"><h2 className="text-xl font-semibold mb-3">Seller plan override</h2><p className="text-sm text-neutral-600 mb-4">Plan overrides are recorded in the audit log. Revoking disables new publishing without deleting seller data or orders.</p>
      <div className="grid sm:grid-cols-2 gap-4"><div><label className="block text-sm mb-1">Seller</label><select className="w-full border rounded-lg p-2.5 bg-white" value={sellerUid} onChange={e=>setSellerUid(e.target.value)}><option value="">Choose seller</option>{(data.sellers||[]).map((s:any)=><option key={s.uid} value={s.uid}>{s.businessName||s.displayName||s.uid} — {s.status}</option>)}</select></div><div><label className="block text-sm mb-1">Plan</label><select className="w-full border rounded-lg p-2.5 bg-white" value={planCode} onChange={e=>setPlanCode(e.target.value)}>{[['STARTER','Starter (20 products)'],['STANDARD','Standard (100 products)'],['GROWTH','Growth (1,000 products)'],['UNLIMITED','Unlimited']].map(([v,l])=><option key={v} value={v}>{l}</option>)}</select></div><div><label className="block text-sm mb-1">Duration in days</label><input className="w-full border rounded-lg p-2.5" type="number" min="1" max="365" value={days} onChange={e=>setDays(e.target.value)}/></div><Input label="Admin reason (optional)" value={reason} onChange={e=>setReason(e.target.value)} maxLength={500} placeholder="Reason for the change"/></div>
      {selected && <p className="text-xs text-neutral-500 mt-3">Current plan: {selected.planCode} · {selected.billingStatus} · expires {selected.subscriptionExpiresAt ? new Date(selected.subscriptionExpiresAt).toLocaleDateString() : 'not set'}</p>}
      <div className="flex gap-2 mt-4 flex-wrap"><Button disabled={!sellerUid||!!busy} loading={busy==='SET_PLAN'} onClick={()=>run('SET_PLAN',{action:'SET_PLAN',sellerUid,planCode,days:Number(days)})}>Assign plan</Button><Button variant="danger" disabled={!sellerUid||!!busy} loading={busy==='REVOKE_PLAN'} onClick={()=>run('REVOKE_PLAN',{action:'REVOKE_PLAN',sellerUid})}>Revoke plan</Button></div>
    </Card>
    <Card className="p-5"><h2 className="text-xl font-semibold mb-2">Product promotion and visibility</h2><p className="text-sm text-neutral-600 mb-4">Promotions last 7 days. Hidden products are removed from the live shop until restored.</p><Input label="Search product or seller" value={search} onChange={e=>setSearch(e.target.value)} placeholder="Type product or business name"/>
      <div className="space-y-3 mt-4">{products.map((p:any)=>{const promoted=!!p.promotedUntil&&new Date(p.promotedUntil).getTime()>Date.now();return <div key={p.id} className="border rounded-xl p-4 flex flex-col md:flex-row md:items-center gap-3"><div className="flex-1 min-w-0"><p className="font-semibold">{p.name}</p><p className="text-sm text-neutral-600">{p.sellerBusinessName||p.sellerUid} · KSh {Number(p.price||0).toLocaleString('en-KE')}</p><p className="text-xs text-neutral-500 mt-1">Status: {p.adminHidden?'Hidden by admin':p.status}{promoted?' · Promoted':''}</p></div><div className="flex gap-2 flex-wrap">{promoted?<Button size="sm" variant="outline" disabled={!!busy} loading={busy===p.id+'-unpromote'} onClick={()=>run(p.id+'-unpromote',{action:'UNPROMOTE',productId:p.id})}><Star className="w-4 h-4 mr-1"/> Remove promotion</Button>:<Button size="sm" disabled={!!busy||p.adminHidden} loading={busy===p.id+'-promote'} onClick={()=>run(p.id+'-promote',{action:'PROMOTE',productId:p.id})}><Star className="w-4 h-4 mr-1"/> Promote 7 days</Button>}{p.adminHidden?<Button size="sm" variant="secondary" disabled={!!busy} loading={busy===p.id+'-restore'} onClick={()=>run(p.id+'-restore',{action:'RESTORE',productId:p.id})}><RotateCcw className="w-4 h-4 mr-1"/> Restore</Button>:<Button size="sm" variant="danger" disabled={!!busy||p.status!=='ACTIVE'} loading={busy===p.id+'-hide'} onClick={()=>run(p.id+'-hide',{action:'HIDE',productId:p.id})}><EyeOff className="w-4 h-4 mr-1"/> Remove from shop</Button>}</div></div>;})}</div>
      {!products.length&&<p className="py-6 text-sm text-neutral-500 text-center">No marketplace products found.</p>}
    </Card>
  </div></div>;
}
