import { FieldValue } from 'firebase-admin/firestore';
import { adminDb, verifyUserToken } from './_lib/firebase-admin.js';
import { clientError, methodNotAllowed } from './_lib/http.js';

const scope = /cheap|lowest|least expensive|affordable|cost|kes|ksh|shoe|heels?|sandals?|flats?|loafers?|platforms?|slides?|footwear|size|sizing|wedding|party|occasion|colour|color|price|budget|stock|available|order|delivery|payment|pay|cart|buy|purchase|product|return|exchange|refund|support|ticket|herstep|collection|shop|shopping|new arrival|bestseller|featured|dress|outfit|work|office|school|birthday|event|style|fashion/i;
const contactText = 'For personal help, contact HerStep on WhatsApp: https://wa.me/254106624924 or email herstepcollection@gmail.com.';
const clean = v => typeof v === 'string' ? v.trim().slice(0, 2000) : '';
const normalizeIntent = v => String(v || '').toLowerCase().replace(/[^a-z0-9\s']/g, ' ').replace(/\s+/g, ' ').trim();
const explicitlyRequestsHuman = value => {
 const text = normalizeIntent(value);
 return /\b(?:talk|speak|chat|connect|transfer|put|switch|escalate|hand over|handover)\b.{0,55}\b(?:to|with|me|a|an|the)?\s*(?:a\s+|an\s+|the\s+)?(?:human|person|real person|live person|agent|representative|rep|customer care|customer service|support team|support staff|someone|somebody)\b/.test(text)
  || /\b(?:i want|i need|can i|could i|may i|let me|please|id like|i would like|i dont want|dont want)\b.{0,55}\b(?:talk|speak|chat|connect|transfer|speak with|talk to)\b.{0,35}\b(?:human|person|agent|representative|customer care|customer service|support|someone|somebody)\b/.test(text)
  || /\b(?:human|real person|live agent|customer care|customer service representative|talk to someone|speak to someone|speak with someone|connect me|transfer me|live support|real human|not a bot|not an ai|stop the bot)\b/.test(text)
  || /\b(?:complaint|wrong order|payment failed|failed payment|cancel my order|refund)\b/.test(text);
};

export default async function assistant(req,res) {
 const body=req.body||{};
 const conversationId=typeof (req.method==='GET'?req.query?.conversationId:body.conversationId)==='string'?(req.method==='GET'?req.query.conversationId:body.conversationId):'';
 if(!/^[a-zA-Z0-9_-]{12,80}$/.test(conversationId)) throw clientError('Please start a new chat and try again.');
 const authorization=String(req.headers?.authorization||'');
 const token=authorization.match(/^Bearer\\s+(.+)$/i)?.[1];
 const user=token?await verifyUserToken(token,false):null;
 const ref=adminDb.collection('aiConversations').doc(conversationId);
 if(req.method==='GET') {
  const snap=await ref.get();
  if(!snap.exists) return res.status(200).json({status:'OPEN',messages:[]});
  const ownerId=String(snap.data().customerId||'');
  if((ownerId&&ownerId!==user?.uid)||(!ownerId&&user)) throw clientError('Conversation not found.',404);
  const messages=await ref.collection('messages').orderBy('createdAt','desc').limit(100).get();
  return res.status(200).json({status:snap.data().status||'OPEN',messages:messages.docs.reverse().map(d=>({id:d.id,...d.data(),createdAt:d.data().createdAt?.toDate?d.data().createdAt.toDate().toISOString():d.data().createdAt||null}))});
 }
 if(req.method!=='POST') return methodNotAllowed(res,['GET','POST']);
 const message=clean(body.message);
 if(!message||message.length>1200) throw clientError('Enter a message under 1,200 characters.');
 const previous=await ref.get();
 if(previous.exists) {
  const ownerId=String(previous.data().customerId||'');
  if((ownerId&&ownerId!==user?.uid)||(!ownerId&&user)) throw clientError('Conversation not found.',404);
 }
 if(!previous.exists) await ref.set({conversationId,customerId:user?.uid||null,customerName:user?(user.name||user.displayName||user.email||'HerStep customer'):'Website visitor',customerEmail:user?.email||'',createdAt:FieldValue.serverTimestamp(),updatedAt:FieldValue.serverTimestamp()},{merge:true});
 const currentStatus=previous.exists?String(previous.data().status||'OPEN'):'OPEN';
 await ref.collection('messages').add({role:'user',content:message,createdAt:FieldValue.serverTimestamp()});
 if(currentStatus==='IN_PROGRESS'||currentStatus==='NEEDS_SUPPORT') {
  await ref.set({lastMessage:message,messageCount:FieldValue.increment(1),updatedAt:FieldValue.serverTimestamp()},{merge:true});
  const ticketId=previous.exists?String(previous.data().ticketId||''):'';
  await ref.collection('messages').add({role:'admin',content:'Message received. A HerStep support agent will reply here.',createdAt:FieldValue.serverTimestamp()});
  await adminDb.collection('supportTickets').doc(`ai_${conversationId}`).set({ticketId:ticketId||`AI-${conversationId.slice(0,8).toUpperCase()}`,customerId:user?.uid||null,customerName:user?(user.name||user.displayName||user.email||'HerStep customer'):'Website visitor',customerEmail:user?.email||'',subject:'AI chat needs human support',category:/payment|pay|mpesa|stk/i.test(message)?'Payment Issue':/delivery|shipping/i.test(message)?'Delivery Issue':/order|refund|cancel/i.test(message)?'Order Issue':'General Enquiry',conversationId,status:currentStatus==='IN_PROGRESS'?'IN_PROGRESS':'OPEN',lastMessage:message,lastMessageAt:FieldValue.serverTimestamp(),lastMessageSenderRole:'CUSTOMER',hasUnreadAdminMessages:true,messageCount:FieldValue.increment(1),updatedAt:FieldValue.serverTimestamp()},{merge:true});
  return res.status(200).json({conversationId,reply:'Your message has been sent to HerStep Support. A team member will reply in this chat. Please keep this window open.',products:[],agentJoined:true,needsHuman:true,ticketId:ticketId||`AI-${conversationId.slice(0,8).toUpperCase()}`});
 }
 // Explicit requests for a person bypass the language model so the handoff cannot be ignored.
 if(explicitlyRequestsHuman(message)) {
  const ticketId=previous.exists&&previous.data().ticketId?String(previous.data().ticketId):`AI-${conversationId.slice(0,8).toUpperCase()}`;
  const reply=`Of course — I’ll pass this conversation to HerStep Support. Your message and chat history are saved, so you won’t need to repeat yourself. Ticket: ${ticketId}. A team member will reply here. If you need help sooner, WhatsApp https://wa.me/254106624924 or email herstepcollection@gmail.com.`;
  await ref.set({conversationId,status:'NEEDS_SUPPORT',ticketId,agentJoined:false,lastMessage:message,lastReply:reply,messageCount:FieldValue.increment(2),updatedAt:FieldValue.serverTimestamp(),...(previous.exists?{}:{createdAt:FieldValue.serverTimestamp()})},{merge:true});
  await ref.collection('messages').add({role:'assistant',content:reply,productIds:[],needsHuman:true,createdAt:FieldValue.serverTimestamp()});
  await adminDb.collection('supportTickets').doc(`ai_${conversationId}`).set({ticketId,customerId:user?.uid||null,customerName:user?(user.name||user.displayName||user.email||'HerStep customer'):'Website visitor',customerEmail:user?.email||'',subject:'Customer requested a human support agent',category:/payment|pay|mpesa|stk/i.test(message)?'Payment Issue':/delivery|shipping/i.test(message)?'Delivery Issue':/order|refund|cancel/i.test(message)?'Order Issue':'General Enquiry',handoffReason:'Customer explicitly requested a human agent',conversationId,status:'OPEN',lastMessage:message,lastMessageAt:FieldValue.serverTimestamp(),lastMessageSenderRole:'CUSTOMER',hasUnreadAdminMessages:true,messageCount:FieldValue.increment(2),...(previous.exists?{}:{createdAt:FieldValue.serverTimestamp()}),updatedAt:FieldValue.serverTimestamp()},{merge:true});
  return res.status(200).json({conversationId,reply,products:[],needsHuman:true,ticketId,supportContacts:{whatsapp:'https://wa.me/254106624924',email:'herstepcollection@gmail.com',phone:'+254799021089'}});
 }
 const replyOutOfScope='I’m the HerStep Collection shopping assistant. I can help with our shoes, colours, sizes, prices, stock, orders, delivery and customer support, but I can’t answer unrelated questions. What kind of shoes are you looking for?';
 const greeting = /^(hi|hello|hey|good morning|good afternoon|good evening|how are you)[!.? ]*$/i.test(message);
 if(!scope.test(message)&&!greeting) {
  await ref.set({status:'OPEN',lastMessage:message,lastReply:replyOutOfScope,messageCount:FieldValue.increment(2),updatedAt:FieldValue.serverTimestamp()},{merge:true});
  await ref.collection('messages').add({role:'assistant',content:replyOutOfScope,productIds:[],createdAt:FieldValue.serverTimestamp()});
  return res.status(200).json({conversationId,reply:replyOutOfScope,products:[],needsHuman:false});
 }
 const snap=await adminDb.collection('products').where('status','==','ACTIVE').limit(1000).get();
 const products=snap.docs.map(d=>{const p=d.data(), inv=Array.isArray(p.inventory)?p.inventory.filter(x=>x&&Number(x.quantity)>0):[];return {id:d.id,name:String(p.name||''),sku:String(p.sku||''),description:String(p.description||'').slice(0,400),categoryId:String(p.categoryId||''),price:Number(p.salePrice)>0&&Number(p.salePrice)<Number(p.price)?Number(p.salePrice):Number(p.price||0),regularPrice:Number(p.price||0),inventory:inv.map(x=>({size:String(x.size),quantity:Number(x.quantity)})),sizes:inv.map(x=>String(x.size)),image:Array.isArray(p.images)?p.images[0]?.url||'':'',featured:!!p.featured,bestseller:!!p.bestseller,newArrival:!!p.newArrival};}).filter(p=>p.name);
 const historySnap=await ref.collection('messages').orderBy('createdAt','desc').limit(12).get();
 const history=historySnap.docs.slice().reverse().map(d=>({role:['assistant','admin'].includes(d.data().role)?'assistant':'user',content:String(d.data().content||'').slice(0,1000)}));
 const cheapestIntent=/\b(?:cheapest|cheaper|lowest priced|lowest price|least expensive|most affordable|cheapest one|cheapest shoes)\b/i.test(message);
 if(cheapestIntent) {
  const stocked=products.filter(p=>p.inventory.length>0&&Number.isFinite(p.price)&&p.price>0).sort((a,b)=>a.price-b.price||a.name.localeCompare(b.name));
  const cheapest=stocked.slice(0,4);
  const priorRecommended=historySnap.docs.find(d=>d.data().role==='assistant'&&Array.isArray(d.data().productIds)&&d.data().productIds.length)?.data().productIds||[];
  const followUp=/\b(?:this|that|it|they|those|these|one)\b/i.test(message)&&/\b(?:cheapest|cheaper|lowest|least expensive)\b/i.test(message);
  let verifiedReply='';
  if(!cheapest.length) verifiedReply='I checked the current catalogue, but I can’t confirm an in-stock shoe price right now. Please try again shortly or contact HerStep Support.';
  else if(followUp&&priorRecommended.length) verifiedReply=priorRecommended.includes(cheapest[0].id)?'Yes — the shoe I recommended is currently the lowest-priced in-stock option at KSh '+cheapest[0].price.toLocaleString()+'. I checked the live catalogue.':'Good question — I verified against the live catalogue. The cheapest in-stock option is '+cheapest[0].name+' at KSh '+cheapest[0].price.toLocaleString()+(cheapest[1]?'; the next is '+cheapest[1].name+' at KSh '+cheapest[1].price.toLocaleString():'')+'. The earlier recommendation was not the cheapest. I’m sorry about that.';
  else verifiedReply='I checked the live HerStep catalogue and sorted shoes with stock by price. The cheapest in-stock options are: '+cheapest.map(p=>p.name+' — KSh '+p.price.toLocaleString()).join('; ')+'. These prices come from the current product records.';
  const verifiedIds=cheapest.map(p=>p.id);
  await ref.set({status:'OPEN',lastMessage:message,lastReply:verifiedReply,messageCount:FieldValue.increment(2),updatedAt:FieldValue.serverTimestamp()},{merge:true});
  await ref.collection('messages').add({role:'assistant',content:verifiedReply,productIds:verifiedIds,createdAt:FieldValue.serverTimestamp()});
  return res.status(200).json({conversationId,reply:verifiedReply,products:cheapest.map(p=>({id:p.id,name:p.name,sku:p.sku,price:p.price,regularPrice:p.regularPrice,sizes:p.sizes,inventory:p.inventory,image:p.image,href:'/product/'+p.id,featured:p.featured,bestseller:p.bestseller,newArrival:p.newArrival})),needsHuman:false});
 }
 const key=String(process.env.GROQ_API_KEY||'').trim();
 let reply='', ids=[], needsHuman=false;
 if(key) {
  const prompt=`You are Aria, the friendly shopping assistant for HerStep Collection, a Kenyan ladies' shoe shop. Introduce yourself as Aria. If asked who you are, say you are Aria and offer to help with shoes and shopping. Only disclose that you are an AI when directly asked whether you are an AI, bot, or human; answer honestly that you are an AI assistant, not a human. Never pretend to be human. Help with HerStep Collection shoes and shopping, but converse naturally about greetings, clarifying questions, comparisons, reactions, and follow-up questions connected to the current shopping conversation. Treat short follow-ups such as “is this the cheapest?”, “what about that one?”, “why?”, and “are you sure?” in context; do not classify them as unrelated just because they omit shoe keywords. Only redirect genuinely unrelated requests such as recipes, general trivia, politics, or homework. Use only the live catalogue for product facts. Never invent products, prices, SKUs, stock, sizes, links, policies or materials. Be warm, patient, conversational, helpful and sales-oriented. Acknowledge concerns and verify facts against the catalogue. Never guess product prices or availability. Recommend only products with at least one in-stock size. If no match, be honest. Links use /product/{id}. If human help is needed, set needsHuman=true; don't claim a ticket has been created. Return JSON only: {"reply":"...","productIds":["exact ids from catalogue, max 4"],"needsHuman":false}.\nCATALOGUE:\n${JSON.stringify(products.map(({id,name,sku,description,price,regularPrice,sizes,inventory,featured,bestseller,newArrival})=>({id,name,sku,description,price,regularPrice,sizes,inventory,featured,bestseller,newArrival})))}`;
  try { const response=await fetch('https://api.groq.com/openai/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model:String(process.env.GROQ_CHAT_MODEL||'qwen/qwen3.8-27b').trim(),temperature:.2,max_tokens:600,response_format:{type:'json_object'},messages:[{role:'system',content:prompt},...history.slice(-7)]}),signal:AbortSignal.timeout(20000)}); if(response.ok){const data=await response.json(), parsed=JSON.parse(data.choices[0].message.content);reply=clean(parsed.reply);ids=Array.isArray(parsed.productIds)?parsed.productIds.filter(id=>products.some(p=>p.id===id)).slice(0,4):[];needsHuman=needsHuman||parsed.needsHuman===true;}else console.error('HerStep AI assistant model error:',response.status,(await response.text()).slice(0,250)); } catch(e){console.error('HerStep AI assistant request failed:',String(e).slice(0,200));}
 }
 if(!reply){reply=products.length?'I can help you find shoes from our live HerStep Collection catalogue. Tell me the occasion, colour, size and budget you have in mind, and I’ll narrow down suitable options.':'I’m here to help with HerStep Collection shoes and shopping. Our live catalogue is temporarily unavailable; please try again shortly.';ids=[];}
 const chosen=products.filter(p=>ids.includes(p.id));
 const ticketId=needsHuman?`AI-${conversationId.slice(0,8).toUpperCase()}`:null;
 await ref.set({conversationId,status:needsHuman?'NEEDS_SUPPORT':'OPEN',...(needsHuman?{ticketId,agentJoined:false}:{}),lastMessage:message,lastReply:reply,messageCount:FieldValue.increment(2),updatedAt:FieldValue.serverTimestamp(),...(previous.exists?{}:{createdAt:FieldValue.serverTimestamp()})},{merge:true});
 await ref.collection('messages').add({role:'assistant',content:needsHuman?reply+'\n\nYour support request has been opened. Ticket: '+ticketId+'\n'+contactText:reply,productIds:ids,needsHuman,createdAt:FieldValue.serverTimestamp()});
 if(needsHuman) await adminDb.collection('supportTickets').doc(`ai_${conversationId}`).set({ticketId,customerId:user?.uid||null,customerName:user?(user.name||user.displayName||user.email||'HerStep customer'):'Website visitor',customerEmail:user?.email||'',subject:'AI chat needs human support',category:/payment|pay|mpesa|stk/i.test(message)?'Payment Issue':/delivery|shipping/i.test(message)?'Delivery Issue':/order|refund|cancel/i.test(message)?'Order Issue':'General Enquiry',conversationId,status:'OPEN',lastMessage:message,lastMessageAt:FieldValue.serverTimestamp(),lastMessageSenderRole:'CUSTOMER',hasUnreadAdminMessages:true,messageCount:FieldValue.increment(2),createdAt:FieldValue.serverTimestamp(),updatedAt:FieldValue.serverTimestamp()},{merge:true});
 return res.status(200).json({conversationId,reply:needsHuman?reply+'\n\nYour support request has been opened. Ticket: '+ticketId+'\n'+contactText:reply,products:chosen.map(p=>({id:p.id,name:p.name,sku:p.sku,price:p.price,regularPrice:p.regularPrice,sizes:p.sizes,inventory:p.inventory,image:p.image,href:`/product/${p.id}`,featured:p.featured,bestseller:p.bestseller,newArrival:p.newArrival})),needsHuman,ticketId,supportContacts:needsHuman?{whatsapp:'https://wa.me/254106624924',email:'herstepcollection@gmail.com',phone:'+254799021089'}:null});
}