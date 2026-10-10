import React,{useEffect,useState} from 'react';
import {Link,useNavigate} from 'react-router-dom';
import {Send,X,Headphones,ShoppingBag} from 'lucide-react';
import {apiFetch} from '../lib/api';
import {useApp} from '../context/AppContext';

type Product={id:string;name:string;sku:string;price:number;href:string;image?:string;sizes:string[];inventory:{size:string;quantity:number}[]};
type Message={role:'assistant'|'user'|'admin';content:string;products?:Product[]};
const ID_KEY='herstep-ai-chat-id-v1';
function getId(userId?:string){const key=userId?ID_KEY+':'+userId:ID_KEY;try{let id=localStorage.getItem(key);if(!id){id=crypto.randomUUID().replace(/-/g,'');localStorage.setItem(key,id)}return id}catch{return crypto.randomUUID().replace(/-/g,'')}}
export function HerStepAIChat(){
 const [open,setOpen]=useState(false),[input,setInput]=useState(''),[sending,setSending]=useState(false),[error,setError]=useState(''),[conversationId,setConversationId]=useState(''),[messages,setMessages]=useState<Message[]>([{role:'assistant',content:'Hi! I’m your Aria 👠 I can help you find shoes by occasion, colour, size, style and budget. What are you looking for?'}]);
 const {state,dispatch}=useApp();
 const navigate=useNavigate();
 useEffect(()=>{if(!state.authReady)return;setConversationId(getId(state.user?.id))},[state.authReady,state.user?.id]);
 useEffect(()=>{
  if(!open||!conversationId)return;
  let active=true;
  const sync=async()=>{
   try{
    const d:any=await apiFetch('/api/assistant?conversationId='+encodeURIComponent(conversationId));
    if(!active)return;
    const restored=(d.messages||[]).map((m:any)=>({
     role:m.role==='user'?'user':m.role==='admin'?'admin':'assistant',
     content:m.content||'',
     products:Array.isArray(m.productIds)?m.productIds.map((id:string)=>state.products.find(p=>p.id===id)).filter(Boolean).map((p:any)=>({id:p.id,name:p.name,sku:p.sku||'',price:p.salePrice!=null&&p.salePrice>0&&p.salePrice<p.price?p.salePrice:p.price,href:'/product/'+p.id,image:p.images?.[0]?.url||'',sizes:(p.inventory||[]).filter((item:any)=>item.quantity>0).map((item:any)=>item.size),inventory:(p.inventory||[]).filter((item:any)=>item.quantity>0)})):[],
    }));
    setMessages(restored.length?restored:[{role:'assistant',content:'Hi! I’m your Aria 👠 I can help you find shoes by occasion, colour, size, style and budget. What are you looking for?'}]);
   }catch{/* Keep the current chat usable if polling briefly fails. */}
  };
  void sync();
  const timer=window.setInterval(()=>void sync(),4000);
  return ()=>{active=false;window.clearInterval(timer)};
 },[open,conversationId,state.products]);
 async function send(text=input){const message=text.trim();if(!message||sending||!conversationId)return;setMessages(old=>[...old,{role:'user',content:message}]);setInput('');setSending(true);setError('');try{let activeId=conversationId;let data:any;try{data=await apiFetch('/api/assistant',{method:'POST',body:JSON.stringify({conversationId:activeId,message})});}catch(firstError:any){const reason=String(firstError?.message||'');if(!/conversation not found|could not complete that request/i.test(reason))throw firstError;const nextId=crypto.randomUUID().replace(/-/g,'');const key=state.user?.id?ID_KEY+':'+state.user.id:ID_KEY;try{localStorage.setItem(key,nextId)}catch{}setConversationId(nextId);activeId=nextId;data=await apiFetch('/api/assistant',{method:'POST',body:JSON.stringify({conversationId:activeId,message})});}setMessages(old=>data.reply?[...old,{role:'assistant',content:data.reply,products:data.products||[]}]:old);}catch(e:any){setError(e.message||'Could not reach the assistant. Please try again.')}finally{setSending(false)}}
 function addToCart(p:Product){const product=state.products.find(x=>x.id===p.id);if(!product){setError('This product is no longer available. Please refresh the shop.');return}const stocked=product.inventory.filter(i=>i.quantity>0);if(!stocked.length){setError('Sorry, this shoe is currently out of stock.');return}const size=stocked.length===1?stocked[0].size:window.prompt('Choose your available size: '+stocked.map(i=>i.size).join(', '));if(!size||!stocked.some(i=>i.size===size))return;dispatch({type:'ADD_TO_CART',payload:{product,size,quantity:1}});setMessages(old=>[...old,{role:'assistant',content:`${product.name} in size ${size} has been added to your cart. You can review your cart before checkout.`}]);}
 return <div className="fixed bottom-[5.6rem] right-4 sm:bottom-[6.1rem] sm:right-6 z-[51] flex flex-col items-end gap-3">
 {open&&<section role="dialog" aria-label="Aria" className="w-[min(92vw,390px)] h-[min(72vh,650px)] bg-white text-neutral-900 border border-neutral-200 rounded-2xl shadow-2xl overflow-hidden flex flex-col">
 <header className="bg-neutral-900 text-white px-4 py-3 flex items-center gap-3"><div className="relative w-10 h-10 shrink-0"><img src="/aria-avatar.jpg" alt="Aria, HerStep Collection shopping assistant" className="w-10 h-10 rounded-full object-cover border-2 border-rose-200" /><span className="absolute -right-0.5 -bottom-0.5 w-3 h-3 rounded-full bg-emerald-500 ring-2 ring-neutral-900" aria-label="Online" /></div><div className="flex-1"><p className="font-semibold text-sm">Aria</p><p className="text-xs text-neutral-300">Shoes, styling and shopping help</p></div><button onClick={()=>setOpen(false)} aria-label="Close AI chat"><X className="w-5 h-5"/></button></header>
 <div className="flex-1 overflow-y-auto p-3 space-y-3">{messages.map((m,i)=><div key={i} className={m.role==='user'?'flex justify-end':'flex justify-start'}><div className={`max-w-[92%] rounded-2xl px-3 py-2 ${m.role==='user'?'bg-neutral-900 text-white':m.role==='admin'?'bg-amber-50 border border-amber-200 text-neutral-900':'bg-neutral-100 text-neutral-900'}`}><p className="text-[10px] opacity-60 mb-1">{m.role==='user'?'You':m.role==='admin'?'HerStep Support':'Aria'}</p><p className="text-sm whitespace-pre-wrap">{m.content}</p>{m.products?.map(p=><div key={p.id} className="mt-3 bg-white text-neutral-900 border rounded-xl p-2 flex gap-2">{p.image&&<img src={p.image} alt={p.name} className="w-16 h-20 object-cover rounded-lg"/>}<div className="min-w-0 flex-1"><Link to={p.href} className="font-medium text-sm underline">{p.name}</Link><p className="text-sm font-semibold mt-1">KSh {p.price.toLocaleString()}</p><p className="text-xs text-neutral-500">SKU: {p.sku||'—'}</p><p className="text-xs text-neutral-500">Sizes: {p.sizes.join(', ')||'Out of stock'}</p><div className="flex gap-2 mt-2"><Link to={p.href} className="text-xs underline">View</Link><button className="text-xs font-medium underline" onClick={()=>addToCart(p)}><ShoppingBag className="inline w-3 h-3 mr-1"/>Add to cart</button></div></div></div>)}</div></div>)}{sending&&<p className="text-xs text-neutral-500">Finding the right shoes…</p>}{error&&<p className="text-xs text-red-600">{error}</p>}</div>
 {state.cart.length>0&&<div className="px-3 pt-3"><button type="button" onClick={()=>navigate('/checkout')} className="w-full rounded-xl bg-neutral-900 text-white py-2.5 text-sm font-semibold">Continue to secure checkout · {state.cart.length} {state.cart.length===1?'item':'items'}</button><p className="text-[10px] text-neutral-500 mt-1">Enter your checkout details to request the M-Pesa STK payment prompt.</p></div>}<form onSubmit={e=>{e.preventDefault();void send()}} className="border-t p-3 flex gap-2"><input value={input} onChange={e=>setInput(e.target.value)} maxLength={1200} placeholder="Tell me what shoes you need…" className="min-w-0 flex-1 border rounded-xl px-3 py-2 text-sm" /><button disabled={sending||!input.trim()} className="rounded-xl bg-neutral-900 text-white px-3 disabled:opacity-40" aria-label="Send message"><Send className="w-4 h-4"/></button></form><p className="px-3 pb-2 text-[10px] text-neutral-400">Aria chats may be stored and reviewed by our support team to help with your shopping or support request.</p>
 {messages.some(m=>m.role==='assistant'&&/support|human|contact/i.test(m.content))&&<div className="px-3 pb-2 text-xs flex gap-3"><a href="https://wa.me/254106624924" className="underline"><Headphones className="inline w-3 h-3"/> Human support</a><a href="mailto:herstepcollection@gmail.com" className="underline">Email</a></div>}
 </section>}
 <button onClick={()=>setOpen(v=>!v)} aria-label={open?'Close Aria':'Chat with Aria'} className="rounded-full w-14 h-14 bg-neutral-900 text-white flex items-center justify-center shadow-xl ring-2 ring-white hover:scale-105"><span className="relative block h-11 w-11"><img src="/aria-avatar.jpg" alt="" className="h-11 w-11 rounded-full object-cover border-2 border-rose-200"/><span className="absolute -right-0.5 -bottom-0.5 h-3 w-3 rounded-full bg-emerald-500 ring-2 ring-white" aria-label="Online"/></span></button>
 </div>
}