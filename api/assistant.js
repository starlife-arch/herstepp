import { FieldValue } from 'firebase-admin/firestore';
import { waitUntil } from '@vercel/functions';
import { adminAuth, adminDb, verifyUserToken } from './_lib/firebase-admin.js';
import { clientError, methodNotAllowed } from './_lib/http.js';
import { emailConfig, deliverQueuedEmailInline, verifySenderConfigured } from './_lib/email-service.js';
import { sendVerifyCode, confirmVerifyCode, verifyKey } from './_lib/routes/email-verify-core.js';
import { emailInvoiceToRecipientCore } from './_lib/routes/invoice-core.js';
import { reconcileBestEffort } from './_lib/order-core.js';
import { detectAriaAccountIntent, resolveAriaAccountIntent } from './_lib/aria-account-core.js';

const scope = /cheap|lowest|least expensive|affordable|cost|kes|ksh|shoe|heels?|sandals?|flats?|loafers?|platforms?|slides?|footwear|size|sizing|wedding|party|occasion|colour|color|price|budget|stock|available|order|delivery|payment|pay|cart|buy|purchase|product|return|exchange|refund|support|ticket|herstep|collection|shop|shopping|new arrival|bestseller|featured|dress|outfit|work|office|school|birthday|event|style|fashion/i;
const contactText = 'For personal help, contact HerStep on WhatsApp: https://wa.me/254106624924 or email herstepcollection@gmail.com.';
const clean = v => typeof v === 'string' ? v.trim().slice(0, 2000) : '';
const validShoePrice = value => Number.isFinite(Number(value)) && Number(value) >= 50 && Number(value) <= 1000000;
const slugifyProductName = name => String(name || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100).replace(/-+$/g, '') || 'shoe';
const productHref = product => '/product/' + encodeURIComponent(slugifyProductName(product.name));
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
 const rawPageContext=body.pageContext&&typeof body.pageContext==='object'?body.pageContext:{};
 const pageType=['home','product','category','cart','checkout','other'].includes(rawPageContext.pageType)?rawPageContext.pageType:'other';
 const pageContext={path:typeof rawPageContext.path==='string'?rawPageContext.path.slice(0,160):'',pageType,productId:typeof rawPageContext.productId==='string'?rawPageContext.productId.slice(0,120):'',productName:typeof rawPageContext.productName==='string'?rawPageContext.productName.slice(0,120):'',category:typeof rawPageContext.category==='string'?rawPageContext.category.slice(0,80):'',cartItems:Array.isArray(rawPageContext.cartItems)?rawPageContext.cartItems.slice(0,5).map(item=>({name:typeof item?.name==='string'?item.name.slice(0,100):'',size:typeof item?.size==='string'?item.size.slice(0,30):'',quantity:Number.isFinite(Number(item?.quantity))?Math.max(1,Math.min(20,Number(item.quantity))):1})):[]};
 const conversationId=typeof (req.method==='GET'?req.query?.conversationId:body.conversationId)==='string'?(req.method==='GET'?req.query.conversationId:body.conversationId):'';
 if(!/^[a-zA-Z0-9_-]{12,80}$/.test(conversationId)) throw clientError('Please start a new chat and try again.');
 const authorization=String(req.headers?.authorization||'');
 const token=authorization.match(/^Bearer\s+(.+)$/i)?.[1];
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
 const previous=await ref.get();
 if(previous.exists) {
  const ownerId=String(previous.data().customerId||'');
  if((ownerId&&ownerId!==user?.uid)||(!ownerId&&user)) throw clientError('Conversation not found.',404);
 }
 if(body.action==='feedback') {
  const rating=Number(body.rating);
  const feedback=typeof body.feedback==='string'?body.feedback.trim().slice(0,1000):'';
  if(!Number.isInteger(rating)||rating<1||rating>5) throw clientError('Please choose a rating from 1 to 5 stars.');
  if(!previous.exists) throw clientError('Conversation not found.',404);
  await ref.collection('feedback').doc('customer-rating').set({rating,feedback,customerId:user?.uid||null,createdAt:FieldValue.serverTimestamp(),updatedAt:FieldValue.serverTimestamp()},{merge:true});
  await ref.set({rating,feedback,feedbackSubmittedAt:FieldValue.serverTimestamp(),updatedAt:FieldValue.serverTimestamp()},{merge:true});
  return res.status(200).json({ok:true});
 }
 const message=clean(body.message);
 if(!message||message.length>1200) throw clientError('Enter a message under 1,200 characters.');
 if(!previous.exists) await ref.set({conversationId,customerId:user?.uid||null,customerName:user?.name||user?.displayName||'Website visitor',customerEmail:user?.email||'',createdAt:FieldValue.serverTimestamp(),updatedAt:FieldValue.serverTimestamp()},{merge:true});
 const currentStatus=previous.exists?String(previous.data().status||'OPEN'):'OPEN';
 const pendingAccountAction=String(previous.data()?.pendingAccountAction||'');
 const isVerificationCodeReply=pendingAccountAction==='verify_email' && /^\d{6}$/.test(message) && Boolean(user?.uid);
 if(!isVerificationCodeReply) await ref.collection('messages').add({role:'user',content:pendingAccountAction==='verify_email' && /^\d{6}$/.test(message)?'[verification code submitted]':message,createdAt:FieldValue.serverTimestamp()});
 if(currentStatus==='IN_PROGRESS'||currentStatus==='NEEDS_SUPPORT') {
  await ref.set({lastMessage:message,messageCount:FieldValue.increment(1),updatedAt:FieldValue.serverTimestamp()},{merge:true});
  const ticketId=previous.exists?String(previous.data().ticketId||''):'';
  await ref.collection('messages').add({role:'admin',content:'Message received. A HerStep support agent will reply here.',createdAt:FieldValue.serverTimestamp()});
  await adminDb.collection('supportTickets').doc(`ai_${conversationId}`).set({ticketId:ticketId||`AI-${conversationId.slice(0,8).toUpperCase()}`,customerId:user?.uid||null,customerName:user?.name||user?.displayName||'Website visitor',customerEmail:user?.email||'',subject:'Aria chat needs human support',category:/payment|pay|mpesa|stk/i.test(message)?'Payment Issue':/delivery|shipping/i.test(message)?'Delivery Issue':/order|refund|cancel/i.test(message)?'Order Issue':'General Enquiry',conversationId,status:currentStatus==='IN_PROGRESS'?'IN_PROGRESS':'OPEN',lastMessage:message,lastMessageAt:FieldValue.serverTimestamp(),lastMessageSenderRole:'CUSTOMER',hasUnreadAdminMessages:true,messageCount:FieldValue.increment(1),updatedAt:FieldValue.serverTimestamp()},{merge:true});
  return res.status(200).json({conversationId,reply:'Your message has been sent to HerStep Support. A team member will reply in this chat. Please keep this window open.',products:[],agentJoined:true,needsHuman:true,ticketId:ticketId||`AI-${conversationId.slice(0,8).toUpperCase()}`});
 }
 // Verification codes are accepted only after Aria requested one in this same signed-in chat.
 // Do not store the six-digit secret in chat history.
 if(isVerificationCodeReply) {
  try {
   const result=await confirmVerifyCode({db:adminDb,now:Date.now(),verifyKey:()=>verifyKey(process.env),markAuthEmailVerified:uid=>adminAuth.updateUser(uid,{emailVerified:true})},user,{code:message});
   const reply=result?.verified?'Your email is now verified — you’re all set!':'I couldn’t confirm that code. Please try again.';
   await ref.set({pendingAccountAction:result?.verified?null:'verify_email',lastMessage:'[verification code submitted]',lastReply:reply,messageCount:FieldValue.increment(1),updatedAt:FieldValue.serverTimestamp()},{merge:true});
   await ref.collection('messages').add({role:'assistant',content:reply,createdAt:FieldValue.serverTimestamp()});
   return res.status(200).json({conversationId,reply,products:[],actions:[],needsHuman:false});
  } catch(error) {
   const reply=String(error?.message||'That code could not be confirmed. Please request a new verification code if it has expired.');
   await ref.set({lastMessage:'[verification code submitted]',lastReply:reply,messageCount:FieldValue.increment(1),updatedAt:FieldValue.serverTimestamp()},{merge:true});
   await ref.collection('messages').add({role:'assistant',content:reply,createdAt:FieldValue.serverTimestamp()});
   return res.status(200).json({conversationId,reply,products:[],actions:[],needsHuman:false});
  }
 }
 // Explicit requests for a person bypass the language model so the handoff cannot be ignored.
 if(explicitlyRequestsHuman(message)) {
  const ticketId=previous.exists&&previous.data().ticketId?String(previous.data().ticketId):`AI-${conversationId.slice(0,8).toUpperCase()}`;
  const reply=`Of course — I’ll pass this conversation to HerStep Support. Your message and chat history are saved, so you won’t need to repeat yourself. Ticket: ${ticketId}. A team member will reply here. If you need help sooner, WhatsApp https://wa.me/254106624924 or email herstepcollection@gmail.com.`;
  await ref.set({conversationId,status:'NEEDS_SUPPORT',ticketId,agentJoined:false,lastMessage:message,lastReply:reply,messageCount:FieldValue.increment(2),updatedAt:FieldValue.serverTimestamp(),...(previous.exists?{}:{createdAt:FieldValue.serverTimestamp()})},{merge:true});
  await ref.collection('messages').add({role:'assistant',content:reply,productIds:[],needsHuman:true,createdAt:FieldValue.serverTimestamp()});
  await adminDb.collection('supportTickets').doc(`ai_${conversationId}`).set({ticketId,customerId:user?.uid||null,customerName:user?.name||user?.displayName||'Website visitor',customerEmail:user?.email||'',subject:'Customer requested a human support agent',category:/payment|pay|mpesa|stk/i.test(message)?'Payment Issue':/delivery|shipping/i.test(message)?'Delivery Issue':/order|refund|cancel/i.test(message)?'Order Issue':'General Enquiry',handoffReason:'Customer explicitly requested a human agent',conversationId,status:'OPEN',lastMessage:message,lastMessageAt:FieldValue.serverTimestamp(),lastMessageSenderRole:'CUSTOMER',hasUnreadAdminMessages:true,messageCount:FieldValue.increment(2),...(previous.exists?{}:{createdAt:FieldValue.serverTimestamp()}),updatedAt:FieldValue.serverTimestamp()},{merge:true});
  return res.status(200).json({conversationId,reply,products:[],needsHuman:true,ticketId,supportContacts:{whatsapp:'https://wa.me/254106624924',email:'herstepcollection@gmail.com',phone:'+254799021089'}});
 }
 const accountIntent=detectAriaAccountIntent(message);
 if(accountIntent) {
  if(accountIntent==='payment' && user?.uid) {
   await reconcileBestEffort(adminDb,{customerId:user.uid}).catch(error=>console.error('[Aria account] payment reconcile failed:',error?.message||error));
  }
  const accountResult=await resolveAriaAccountIntent({
   db:adminDb,user,message,
   sendVerification:verifiedUser=>sendVerifyCode({
    db:adminDb,now:Date.now(),waitUntil,deliverQueuedEmailInline,
    verifySenderConfigured:()=>verifySenderConfigured(emailConfig()),
    verifyKey:()=>verifyKey(process.env),
    markAuthEmailVerified:uid=>adminAuth.updateUser(uid,{emailVerified:true}),
   },verifiedUser,{}),
   confirmVerification:(verifiedUser,code)=>confirmVerifyCode({db:adminDb,now:Date.now(),verifyKey:()=>verifyKey(process.env),markAuthEmailVerified:uid=>adminAuth.updateUser(uid,{emailVerified:true})},verifiedUser,{code}),
   sendInvoice:({uid,orderDocumentId,email})=>emailInvoiceToRecipientCore({db:adminDb,uid,orderDocumentId,email}),
   conversationState:{pendingAccountAction},
  });
  const accountReply=String(accountResult?.reply||'I couldn’t retrieve that account information just now. Please try again or contact HerStep Support.');
  const actions=Array.isArray(accountResult?.actions)?accountResult.actions:[];
  const nextPendingAction=accountResult?.clearPendingAction?null:accountResult?.nextAction==='verify_email'||accountResult?.keepPendingAction?'verify_email':null;
  await ref.set({status:'OPEN',lastMessage:isVerificationCodeReply?'[verification code submitted]':message,lastReply:accountReply,pendingAccountAction:nextPendingAction,messageCount:FieldValue.increment(2),updatedAt:FieldValue.serverTimestamp()},{merge:true});
  await ref.collection('messages').add({role:'assistant',content:accountReply,actions,createdAt:FieldValue.serverTimestamp()});
  return res.status(200).json({conversationId,reply:accountReply,products:[],actions,needsHuman:false});
 }
 const replyOutOfScope='I’m Aria, your HerStep Collection shopping assistant 😊 I’m best at helping with our shoes, styles, sizes, colours, prices, orders and delivery. I can’t help with recipes or unrelated topics, but I’m happy to help you find the right pair. Are you shopping for everyday wear, work, an event, or something else?';
 const clearlyOffTopic = /\b(?:what can i cook|what should i cook|recipe|recipes|cooking ideas|cook for dinner|homework|solve this equation|politics|president of|weather forecast|write my essay)\b/i.test(message);
  const greeting = /^(hi|hello|hey|good morning|good afternoon|good evening|how are you|how's it going|how are things|how have you been|what's up)[!.? ]*$/i.test(message);
  if (greeting) {
   const reply = /how are you|how's it going|how are things|how have you been|what's up/i.test(message) ? 'I’m doing well, thank you for asking 😊 I’m here with you. And how are you? If you’re browsing shoes, I can help with that too.' : 'Hey there! 😊 Lovely to see you. What can I help you find today? We can browse together, compare prices, or look for a style you have in mind.';
   await ref.set({status:'OPEN',lastMessage:message,lastReply:reply,messageCount:FieldValue.increment(2),updatedAt:FieldValue.serverTimestamp()},{merge:true});
   await ref.collection('messages').add({role:'assistant',content:reply,productIds:[],createdAt:FieldValue.serverTimestamp()});
   return res.status(200).json({conversationId,reply,products:[],needsHuman:false});
  }
 const historySnap=await ref.collection('messages').orderBy('createdAt','desc').limit(12).get();
 const recentHistory=historySnap.docs.map(d=>({role:d.data().role,content:String(d.data().content||'')})).reverse();
 const hasRelevantContext=recentHistory.slice(-6).some(m=>/order|payment|invoice|verification|verify|code|delivery|tracking|support|shoe|size|price|stock/i.test(m.content));
 const contextualFollowUp=(hasRelevantContext && (message.length<100 || /\b(this|that|it|they|those|these|one|already|yes|no|both|do that|send it|help me|the first|the second|what about|i have|received|got it)\b/i.test(message))) || (pageContext.pageType==='product' && message.length<100 && /\b(this|that|it|they|those|these|one|what about|compare|similar|available|size|colour|color|price)\b/i.test(message));
 if(clearlyOffTopic || (!scope.test(message)&&!greeting&&!contextualFollowUp)) {
  await ref.set({status:'OPEN',lastMessage:message,lastReply:replyOutOfScope,messageCount:FieldValue.increment(2),updatedAt:FieldValue.serverTimestamp()},{merge:true});
  await ref.collection('messages').add({role:'assistant',content:replyOutOfScope,productIds:[],createdAt:FieldValue.serverTimestamp()});
  return res.status(200).json({conversationId,reply:replyOutOfScope,products:[],needsHuman:false});
 }
 const snap=await adminDb.collection('products').where('status','==','ACTIVE').limit(1000).get();
  const products=snap.docs.map(d=>{const p=d.data(), inv=Array.isArray(p.inventory)?p.inventory.filter(x=>x&&Number(x.quantity)>0):[], basePrice=Number(p.price), salePrice=Number(p.salePrice), price=validShoePrice(salePrice)&&validShoePrice(basePrice)&&salePrice<basePrice?salePrice:basePrice;return {id:d.id,name:String(p.name||''),sku:String(p.sku||''),description:String(p.description||'').slice(0,400),categoryId:String(p.categoryId||''),price,regularPrice:basePrice,inventory:inv.map(x=>({size:String(x.size),quantity:Number(x.quantity)})),sizes:inv.map(x=>String(x.size)),image:Array.isArray(p.images)?p.images[0]?.url||'':'',featured:!!p.featured,bestseller:!!p.bestseller,newArrival:!!p.newArrival};}).filter(p=>p.name&&validShoePrice(p.price));
 const history=historySnap.docs.slice().reverse().map(d=>({role:['assistant','admin'].includes(d.data().role)?'assistant':'user',content:String(d.data().content||'').slice(0,1000)}));
 const latestUserText=normalizeIntent(message);
 const lastAssistantText=history.filter(m=>m.role==='assistant').slice(-1)[0]?.content||'';
 const affirmative=/^(?:yes|yeah|yep|yup|sure|okay|ok|of course|please)$/i.test(latestUserText);
 const greetingOffer=/how are you|how about you|if you(?:'|’)re browsing shoes|i can help with that too|what can i help you find today/i.test(lastAssistantText);
 if(affirmative&&greetingOffer) {
   const reply='Lovely 😊 What would you like help with today — finding a pair of shoes, comparing prices, checking a size, or choosing something for a particular occasion?';
   await ref.set({status:'OPEN',lastMessage:message,lastReply:reply,messageCount:FieldValue.increment(2),updatedAt:FieldValue.serverTimestamp()},{merge:true});
   await ref.collection('messages').add({role:'assistant',content:reply,productIds:[],createdAt:FieldValue.serverTimestamp()});
   return res.status(200).json({conversationId,reply,products:[],needsHuman:false});
 }
 const cheapestIntent=/\b(?:cheapest|cheaper|lowest priced|lowest price|least expensive|most affordable|cheapest one|cheapest shoes)\b/i.test(message);
 if(cheapestIntent) {
   const stocked=products.filter(p=>p.inventory.length>0&&validShoePrice(p.price)).sort((a,b)=>a.price-b.price||a.name.localeCompare(b.name));
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
  return res.status(200).json({conversationId,reply:verifiedReply,products:cheapest.map(p=>({id:p.id,name:p.name,sku:p.sku,price:p.price,regularPrice:p.regularPrice,sizes:p.sizes,inventory:p.inventory,image:p.image,href:productHref(p),featured:p.featured,bestseller:p.bestseller,newArrival:p.newArrival})),needsHuman:false});
 }
 const key=String(process.env.GROQ_API_KEY||'').trim();
 let reply='', ids=[], needsHuman=false;
 if(key) {
  const prompt=`You are Aria, the personal shopping assistant for HerStep Collection, a Kenyan ladies' shoe shop. Your name is Aria: if someone asks who you are, say “I’m Aria” naturally. Only explain that you are an AI assistant if the customer directly asks whether you are AI, a bot, or human; answer honestly when asked. Keep a warm, friendly, confident, polished, feminine, patient, conversational tone, like a helpful personal stylist—not a robotic script or a generic branded chatbot. Maintain this identity throughout the conversation and do not rename yourself. Help with HerStep Collection shoes and shopping, but converse naturally about greetings, clarifying questions, comparisons, reactions, and follow-up questions connected to the current shopping conversation. Treat short follow-ups such as “is this the cheapest?”, “what about that one?”, “why?”, and “are you sure?” in context; do not classify them as unrelated just because they omit shoe keywords. Keep track of facts the customer has already supplied (occasion, size, colour, budget, preferred style) and do not ask for them again. If the customer says “wedding”, acknowledge wedding as the occasion and move to one useful next question or recommend matching in-stock catalogue items; never repeat the generic opening question. Ask at most one concise follow-up question at a time. Respond to the actual latest message, not with a fixed FAQ script. Only redirect genuinely unrelated requests such as recipes, general trivia, politics, or homework. Use only the live catalogue for product facts. Never invent products, prices, SKUs, stock, sizes, links, policies or materials. Be warm, patient, conversational, helpful and sales-oriented. Acknowledge concerns and verify facts against the catalogue. Never guess product prices or availability. Recommend only products with at least one in-stock size. If no match, be honest. Links use /product/{slug}, where slug is the readable lowercase hyphenated product name. If human help is needed, set needsHuman=true; don't claim a ticket has been created. Use the CURRENT STOREFRONT CONTEXT as a navigation hint to understand references like “this shoe” or “my cart”. It comes from the website UI and is not authoritative product data: only state prices, stock, sizes and product facts from the live catalogue below. If the current page identifies a product, prioritize helping with that product when relevant; for cart questions, refer to the provided cart items without inventing checkout status.\\nCURRENT STOREFRONT CONTEXT:\\n${JSON.stringify(pageContext)}\\nReturn JSON only: {"reply":"...","productIds":["exact ids from catalogue, max 4"],"needsHuman":false}.\nCATALOGUE:\n${JSON.stringify(products.map(({id,name,sku,description,price,regularPrice,sizes,inventory,featured,bestseller,newArrival})=>({id,name,sku,description,price,regularPrice,sizes,inventory,featured,bestseller,newArrival})))}`;
  try { const response=await fetch('https://api.groq.com/openai/v1/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model:String(process.env.GROQ_CHAT_MODEL||'qwen/qwen3.8-27b').trim(),temperature:.2,max_tokens:600,response_format:{type:'json_object'},messages:[{role:'system',content:prompt},...history.slice(-7)]}),signal:AbortSignal.timeout(20000)}); if(response.ok){const data=await response.json(), parsed=JSON.parse(data.choices[0].message.content);reply=clean(parsed.reply);ids=Array.isArray(parsed.productIds)?parsed.productIds.filter(id=>products.some(p=>p.id===id)).slice(0,4):[];needsHuman=needsHuman||parsed.needsHuman===true;}else console.error('HerStep AI assistant model error:',response.status,(await response.text()).slice(0,250)); } catch(e){console.error('HerStep AI assistant request failed:',String(e).slice(0,200));}
 }
 if(!reply){
  // Deterministic fallback keeps the conversation useful even when Groq is unavailable.
  const recentUserMessages=history.filter(m=>m.role==='user').slice(-8).map(m=>m.content);
  const conversationText=recentUserMessages.join(' ').toLowerCase();
  const occasionTerms=['wedding','work','office','party','birthday','school','church','casual','holiday','graduation','formal','kitchen','cooking'];
  const occasion=occasionTerms.find(term=>message.toLowerCase().includes(term)||conversationText.includes(term));
  const sizeMatch=conversationText.match(/\b(?:shoe\s*)?size\s*(?:is\s*)?(3[0-9]|4[0-5])\b/i)||conversationText.match(/\bi\s+wear\s+(3[0-9]|4[0-5])\b/i);
  const requestedSize=sizeMatch?.[1]||'';
  const sizeProvided=Boolean(requestedSize)||/\b(?:size\s*)?(?:3[0-9]|4[0-5])\b/i.test(conversationText);
  const budgetMatch=conversationText.match(/\b(?:ksh|kes|budget|under|below)\s*(?:ksh|kes)?\s*(\d{2,6})\b/i);
  const budgetProvided=/\b(?:ksh|kes|shilling|budget|under|below|between)\b/i.test(conversationText);
  const colourProvided=/\b(?:black|white|red|blue|pink|brown|beige|nude|gold|silver|green|cream|purple)\b/i.test(conversationText);
  const stocked=products.filter(p=>p.inventory.length>0&&validShoePrice(p.price)&&(!requestedSize||p.inventory.some(item=>String(item.size)===requestedSize)));
  const pattern=occasion==='wedding'?/heel|pump|court|sandal|elegant|formal|dress/i:occasion==='work'||occasion==='office'||occasion==='kitchen'||occasion==='cooking'?/flat|loafer|low heel|comfortable|work|closed/i:occasion==='party'||occasion==='birthday'?/heel|sandal|platform|dress|party/i:occasion==='school'?/flat|loafer|sneaker|school/i:/heel|sandal|flat|loafer|dress/i;
  let matching=occasion?stocked.filter(p=>pattern.test(p.name+' '+p.description+' '+p.categoryId)):stocked;
  if(budgetMatch){const max=Number(budgetMatch[1]);if(Number.isFinite(max)&&max>0)matching=matching.filter(p=>p.price<=max);}
  const recommendations=(matching.length?matching:((occasion||budgetMatch)?[]:stocked)).slice(0,3);
   const latest=message.trim().toLowerCase();
   const isShortPreference=/^(?:heels?|flats?|sandals?|loafers?|black|white|red|blue|pink|brown|beige|nude|gold|silver|green|cream|purple|size\s*(?:3[0-9]|4[0-5])|(?:3[0-9]|4[0-5])|yes|yeah|yep|no|nope|okay|ok|sure|please|the first|the second|show me|full shop|another size)$/i.test(latest);
   const recentAssistant=history.filter(m=>m.role==='assistant').slice(-1)[0]?.content||'';
   const previousAskedAboutSizeAlternatives=/another size|full shop|different size|nearby size/i.test(recentAssistant);
   if(!products.length) reply='I’m sorry — I can’t reach the live catalogue right now. You can still browse the shop, and I can try again if you send another message.';
   else if(previousAskedAboutSizeAlternatives && /^(?:yes|yeah|yep|sure|okay|ok|please)$/i.test(latest)) reply='Of course 😊 Which would you prefer: I can look at nearby sizes, or show you all the shoes currently in the shop.';
   else if(sizeProvided&&!stocked.length && isShortPreference) reply='Got it — '+( /heel/i.test(latest)?'you’d prefer heels':/flat/i.test(latest)?'you’d prefer flats':/sandals?/i.test(latest)?'you’d prefer sandals':/black/i.test(latest)?'you’d like black shoes':/white/i.test(latest)?'you’d like white shoes':'I’ll keep that preference in mind')+'. I still can’t confirm stock in size '+requestedSize+'. Would you like me to check nearby sizes for that style, or show you all available options?';
   else if(sizeProvided&&!stocked.length) reply='I remember you need size '+requestedSize+', and I can’t confirm any in-stock shoes in that size right now. We can try nearby sizes or browse the full shop—which would you prefer?';
  else if(budgetMatch&&!recommendations.length) reply='I couldn’t find an in-stock match within KSh '+Number(budgetMatch[1]).toLocaleString()+(requestedSize?' in size '+requestedSize:'')+'. Would you like to increase your budget a little or see the closest options?';
  else if(occasion&&!recommendations.length) reply='I couldn’t find a clear match for '+occasion+' in the live catalogue right now. I can still help you compare the available shoes—would you prefer comfort, flats, or heels?';
  else if(occasion&&recommendations.length){
   ids=recommendations.map(p=>p.id);
   const list=recommendations.map(p=>p.name+' (KSh '+p.price.toLocaleString()+')').join('; ');
   if(occasion==='wedding') reply='Wedding shoes — lovely! 💛 I checked the live catalogue and these in-stock options may be a good starting point: '+list+'. '+(sizeProvided?'Would you prefer heels or flats?':colourProvided?'Which colour would you prefer?':budgetProvided?'Would you prefer heels or flats?':'What shoe size do you wear?');
   else if(occasion==='cooking'||occasion==='kitchen') reply='For cooking or standing in the kitchen, comfort and stability matter. These in-stock styles may be worth a look: '+list+'. Do you prefer closed shoes or open sandals?';
   else reply='Got it — '+occasion+' shoes. I checked the live catalogue and these in-stock options may suit you: '+list+'. '+(sizeProvided?'Would you prefer heels or flats?':colourProvided?'What shoe style do you prefer?':'What colour would you prefer?');
  } else if(sizeProvided&&recommendations.length){
   ids=recommendations.map(p=>p.id);
   reply='Size '+requestedSize+' — got it! 😊 I’ve checked the live catalogue for shoes with stock in your size: '+recommendations.map(p=>p.name+' (KSh '+p.price.toLocaleString()+')').join('; ')+'. What occasion or budget should I use to narrow these down?';
  } else if(message.trim().split(/\s+/).length<=5&&history.length>1) reply='Thanks, I’ll keep that in mind. I won’t ask you for the same detail again. Are you looking for everyday shoes, work shoes, or a pair for a special occasion?';
  else reply='I’m Aria, your HerStep shopping assistant 😊 Tell me what you have in mind—everyday comfort, work, a special occasion, a colour, or a budget—and I’ll help you explore the live catalogue.';
 }
 const chosen=products.filter(p=>ids.includes(p.id));
 const ticketId=needsHuman?`AI-${conversationId.slice(0,8).toUpperCase()}`:null;
 await ref.set({conversationId,status:needsHuman?'NEEDS_SUPPORT':'OPEN',...(needsHuman?{ticketId,agentJoined:false}:{}),lastMessage:message,lastReply:reply,messageCount:FieldValue.increment(2),updatedAt:FieldValue.serverTimestamp(),...(previous.exists?{}:{createdAt:FieldValue.serverTimestamp()})},{merge:true});
 await ref.collection('messages').add({role:'assistant',content:needsHuman?reply+'\n\nYour support request has been opened. Ticket: '+ticketId+'\n'+contactText:reply,productIds:ids,needsHuman,createdAt:FieldValue.serverTimestamp()});
 if(needsHuman) await adminDb.collection('supportTickets').doc(`ai_${conversationId}`).set({ticketId,customerId:user?.uid||null,customerName:user?.name||user?.displayName||'Website visitor',customerEmail:user?.email||'',subject:'Aria chat needs human support',category:/payment|pay|mpesa|stk/i.test(message)?'Payment Issue':/delivery|shipping/i.test(message)?'Delivery Issue':/order|refund|cancel/i.test(message)?'Order Issue':'General Enquiry',conversationId,status:'OPEN',lastMessage:message,lastMessageAt:FieldValue.serverTimestamp(),lastMessageSenderRole:'CUSTOMER',hasUnreadAdminMessages:true,messageCount:FieldValue.increment(2),createdAt:FieldValue.serverTimestamp(),updatedAt:FieldValue.serverTimestamp()},{merge:true});
 return res.status(200).json({conversationId,reply:needsHuman?reply+'\n\nYour support request has been opened. Ticket: '+ticketId+'\n'+contactText:reply,products:chosen.map(p=>({id:p.id,name:p.name,sku:p.sku,price:p.price,regularPrice:p.regularPrice,sizes:p.sizes,inventory:p.inventory,image:p.image,href:productHref(p),featured:p.featured,bestseller:p.bestseller,newArrival:p.newArrival})),needsHuman,ticketId,supportContacts:needsHuman?{whatsapp:'https://wa.me/254106624924',email:'herstepcollection@gmail.com',phone:'+254799021089'}:null});
}