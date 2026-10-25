import React,{useEffect,useMemo,useState} from 'react';
import {Link} from 'react-router-dom';
import {ArrowLeft,RefreshCw,Star,MessageSquare} from 'lucide-react';
import {apiFetch} from '../lib/api';
import {Card,Button,Badge} from '../components/ui';

export default function AdminAriaFeedback(){
 const [items,setItems]=useState<any[]>([]),[loading,setLoading]=useState(true),[error,setError]=useState(''),[filter,setFilter]=useState('all');
 async function load(){setLoading(true);setError('');try{const d:any=await apiFetch('/api/admin/ai-chats?feedback=1');setItems(d.feedback||[])}catch(e:any){setError(e?.message||'Could not load Aria feedback.')}finally{setLoading(false)}}
 useEffect(()=>{void load()},[]);
 const visible=useMemo(()=>items.filter(item=>filter==='all'||(filter==='low'?Number(item.rating)<=3:Number(item.rating)>=4)),[items,filter]);
 const average=items.length?items.reduce((sum,item)=>sum+Number(item.rating||0),0)/items.length:0;
 const fmt=(v:any)=>v?new Date(v).toLocaleString('en-KE',{weekday:'short',day:'numeric',month:'short',year:'numeric',hour:'2-digit',minute:'2-digit'}):'—';
 return <main className="max-w-5xl mx-auto p-4 sm:p-6 space-y-5">
  <Link to="/admin" className="inline-flex items-center gap-2 text-sm text-neutral-500"><ArrowLeft className="w-4 h-4"/>Platform Operations</Link>
  <div className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="text-2xl font-bold">Aria Feedback</h1><p className="text-sm text-neutral-500 mt-1">Customer star ratings and suggestions about Aria.</p></div><div className="flex gap-2"><Link to="/admin/ai-chats"><Button variant="outline"><MessageSquare className="w-4 h-4 mr-2"/>View chats</Button></Link><Button variant="outline" onClick={load}><RefreshCw className="w-4 h-4 mr-2"/>Refresh</Button></div></div>
  {error&&<Card className="p-4 text-sm text-red-600">{error}</Card>}
  <div className="grid grid-cols-1 sm:grid-cols-3 gap-3"><Card className="p-4"><p className="text-sm text-neutral-500">Ratings received</p><p className="text-2xl font-bold mt-1">{items.length}</p></Card><Card className="p-4"><p className="text-sm text-neutral-500">Average rating</p><p className="text-2xl font-bold mt-1">{items.length?average.toFixed(1)+' / 5':'—'}</p></Card><Card className="p-4"><p className="text-sm text-neutral-500">Ratings of 3 stars or less</p><p className="text-2xl font-bold mt-1">{items.filter(item=>Number(item.rating)<=3).length}</p></Card></div>
  <div className="flex flex-wrap items-center gap-2"><span className="text-sm text-neutral-500">Show:</span>{[['all','All feedback'],['low','1–3 stars'],['high','4–5 stars']].map(([value,label])=><button key={value} onClick={()=>setFilter(value)} className={'rounded-full border px-3 py-1.5 text-sm '+(filter===value?'bg-neutral-900 text-white border-neutral-900':'bg-white text-neutral-700')}>{label}</button>)}</div>
  {loading?<Card className="p-8 text-center text-sm text-neutral-500">Loading feedback…</Card>:visible.length?visible.map(item=><Card key={item.id} className="p-4 space-y-3"><div className="flex flex-wrap items-start justify-between gap-2"><div><p className="font-semibold break-all">{item.customerName||'Website visitor'}</p><p className="text-xs text-neutral-500 mt-1">{fmt(item.feedbackSubmittedAt||item.updatedAt)} · Conversation {item.id}</p></div><Badge>{Number(item.rating)||0} / 5 stars</Badge></div><div className="flex items-center gap-1" aria-label={(Number(item.rating)||0)+' out of 5 stars'}>{[1,2,3,4,5].map(n=><Star key={n} className={'w-5 h-5 '+(n<=Number(item.rating)?'fill-amber-400 text-amber-500':'text-neutral-300')}/>)}</div><div><p className="text-xs uppercase tracking-wide text-neutral-500 mb-1">What we can improve</p><p className="text-sm whitespace-pre-wrap">{item.feedback?.trim()||'No written comment provided.'}</p></div><Link to={'/admin/ai-chats?conversationId='+encodeURIComponent(item.id)} className="inline-block text-sm underline underline-offset-2">Open related chat</Link></Card>):<Card className="p-8 text-center text-sm text-neutral-500">{items.length?'No feedback matches this filter yet.':'No Aria ratings have been submitted yet.'}</Card>}
  <p className="text-xs text-neutral-500">Feedback is visible to authorised admins. The list checks the most recently updated 500 conversations; older feedback may not appear if the store has more than 500 conversations.</p>
 </main>;
}
