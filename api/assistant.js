import { FieldValue } from 'firebase-admin/firestore';
import { waitUntil } from '@vercel/functions';
import { adminAuth, adminDb, verifyUserToken } from './_lib/firebase-admin.js';
import { clientError, methodNotAllowed } from './_lib/http.js';
import { emailConfig, deliverQueuedEmailInline, verifySenderConfigured } from './_lib/email-service.js';
import { sendVerifyCode, confirmVerifyCode, verifyKey } from './_lib/routes/email-verify-core.js';
import { emailInvoiceToRecipientCore } from './_lib/routes/invoice-core.js';
import { reconcileBestEffort } from './_lib/order-core.js';
import { detectAriaAccountIntent, resolveAriaAccountIntent } from './_lib/aria-account-core.js';

// ========================
// CONSTANTS
// ========================
const scope = /cheap|lowest|least expensive|affordable|cost|kes|ksh|shoe|heels?|sandals?|flats?|loafers?|platforms?|slides?|footwear|size|sizing|wedding|party|occasion|colour|color|price|budget|stock|available|order|delivery|payment|pay|cart|buy|purchase|product|return|exchange|refund|support|ticket|herstep|collection|shop|shopping|new arrival|bestseller|featured|dress|outfit|work|office|school|birthday|event|style|fashion/i;

const conversational = /\b(how are you|how'?s it going|how are things|who are you|what'?s your name|what is your name|can you help|what can you do|what do you do|tell me about (you|yourself)|are you (a )?(bot|human|ai|real)|nice to meet you|thank you|thanks|thank u|good to (see|meet) you|good job|well done|are you there|you there)\b/i;

const greeting = /^(hi|hello|hey|hiya|yo|sup|heya|hallo|helo|hii+|good morning|good afternoon|good evening|good day|morning|evening|greetings|howdy)[!.?,\s]*$/i;

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

// ========================
// USER MEMORY (PER SIGNED-IN USER)
// ========================
async function getProfile(userId) {
  if (!userId) return {};
  try {
    const snap = await adminDb.collection('ariaProfiles').doc(userId).get();
    return snap.exists ? snap.data() : {};
  } catch { return {}; }
}

async function updateProfile(userId, updates) {
  if (!userId || !updates || !Object.keys(updates).length) return;
  try {
    await adminDb.collection('ariaProfiles').doc(userId).set(
      { ...updates, updatedAt: FieldValue.serverTimestamp() },
      { merge: true }
    );
  } catch (e) {
    console.error('[Aria] profile update failed:', e?.message);
  }
}

function extractProfileInfo(message) {
  const text = String(message || '').toLowerCase();
  const updates = {};

  const sizeMatch = text.match(/\b(?:size|eu|uk)\s*(\d{2})\b/) || text.match(/\b(\d{2})\b/);
  if (sizeMatch) {
    const n = Number(sizeMatch[1]);
    if (n >= 30 && n <= 50) updates.shoeSize = String(n);
  }

  const nameMatch = text.match(/(?:my name is|i am|i'?m|call me)\s+([a-z]{2,20})/i);
  if (nameMatch) {
    const n = nameMatch[1];
    updates.name = n.charAt(0).toUpperCase() + n.slice(1).toLowerCase();
  }

  const occasions = ['wedding', 'work', 'office', 'party', 'casual', 'church', 'date', 'interview', 'school', 'funeral', 'birthday'];
  for (const occ of occasions) {
    if (text.includes(occ)) { updates.occasion = occ; break; }
  }

  const budget = text.match(/(?:under|below|budget of|about|around|max)\s*(?:ksh|kes)?\s*(\d+)/);
  if (budget) updates.budget = Number(budget[1]);

  return updates;
}

function buildProfileContext(profile) {
  if (!profile || !Object.keys(profile).length) return '';
  const bits = [];
  if (profile.name) bits.push('Name: ' + profile.name);
  if (profile.shoeSize) bits.push('Shoe size: ' + profile.shoeSize);
  if (profile.occasion) bits.push('Shopping for: ' + profile.occasion);
  if (profile.budget) bits.push('Budget: KSh ' + profile.budget);
  return bits.length ? '\nKNOWN ABOUT THIS CUSTOMER (use naturally, do NOT ask again): ' + bits.join('. ') + '.' : '';
}

// ========================
// TOKEN-BUDGET-AWARE PRODUCT SELECTION
// ========================
function pickRelevantProducts(allProducts, message) {
  const msgLower = String(message || '').toLowerCase();
  const sizeMatch = msgLower.match(/\b(?:size|eu|uk)\s*(\d{2})\b/);
  const size = sizeMatch ? sizeMatch[1] : null;

  const scored = allProducts.map(p => {
    let score = 0;
    const text = (p.name + ' ' + p.description).toLowerCase();

    // Price intent
    if (/cheap|budget|affordable|lowest|least expensive/.test(msgLower)) {
      score += Math.max(0, 2000 - p.price) / 2000 * 5;
    }

    // Occasion
    if (msgLower.includes('wedding') && /wedding|bridal|elegant|rhinestone|glitter/.test(text)) score += 3;
    if ((msgLower.includes('work') || msgLower.includes('office')) && /work|office|flat|loafer/.test(text)) score += 3;
    if (msgLower.includes('party') && /party|glitter|rhinestone|stiletto/.test(text)) score += 3;
    if (msgLower.includes('casual') && /casual|flat|slide|sandal/.test(text)) score += 2;
    if (msgLower.includes('church') && /flat|block heel|modest/.test(text)) score += 2;

    // Category words
    if (msgLower.includes('heel') && /heel/i.test(p.name)) score += 2;
    if (msgLower.includes('flat') && /flat/i.test(p.name)) score += 2;
    if (msgLower.includes('sandal') && /sandal|slide/i.test(p.name)) score += 2;
    if (msgLower.includes('platform') && /platform/i.test(p.name)) score += 2;
    if (msgLower.includes('stiletto') && /stiletto/i.test(p.name)) score += 3;
    if (msgLower.includes('loafer') && /loafer/i.test(p.name)) score += 3;

    // Size match
    if (size && p.sizes.includes(size)) score += 4;

    // Soft preference for quality signals
    if (p.featured) score += 0.5;
    if (p.bestseller) score += 0.5;
    if (p.newArrival) score += 0.3;
    if (p.sizes.length > 0) score += 0.2;

    return { p, score };
  });

  const matched = scored.filter(x => x.score > 0).sort((a, b) => b.score - a.score).slice(0, 30).map(x => x.p);
  if (matched.length) return matched;

  // Fallback: cheapest in-stock items
  return allProducts
    .filter(p => p.sizes.length > 0)
    .sort((a, b) => a.price - b.price)
    .slice(0, 30);
}

// ========================
// MAIN HANDLER
// ========================
export default async function assistant(req, res) {
  const body = req.body || {};
  const conversationId = typeof (req.method === 'GET' ? req.query?.conversationId : body.conversationId) === 'string'
    ? (req.method === 'GET' ? req.query.conversationId : body.conversationId)
    : '';
  if (!/^[a-zA-Z0-9_-]{12,80}$/.test(conversationId)) throw clientError('Please start a new chat and try again.');

  const authorization = String(req.headers?.authorization || '');
  const token = authorization.match(/^Bearer\s+(.+)$/i)?.[1];
  const user = token ? await verifyUserToken(token, false) : null;
  const ref = adminDb.collection('aiConversations').doc(conversationId);

  if (req.method === 'GET') {
    const snap = await ref.get();
    if (!snap.exists) return res.status(200).json({ status: 'OPEN', messages: [] });
    const ownerId = String(snap.data().customerId || '');
    if ((ownerId && ownerId !== user?.uid) || (!ownerId && user)) throw clientError('Conversation not found.', 404);
    const messages = await ref.collection('messages').orderBy('createdAt', 'desc').limit(100).get();
    return res.status(200).json({
      status: snap.data().status || 'OPEN',
      messages: messages.docs.reverse().map(d => ({
        id: d.id,
        ...d.data(),
        createdAt: d.data().createdAt?.toDate ? d.data().createdAt.toDate().toISOString() : d.data().createdAt || null
      }))
    });
  }

  if (req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);

  const message = clean(body.message);
  if (!message || message.length > 1200) throw clientError('Enter a message under 1,200 characters.');

  const previous = await ref.get();
  if (previous.exists) {
    const ownerId = String(previous.data().customerId || '');
    if ((ownerId && ownerId !== user?.uid) || (!ownerId && user)) throw clientError('Conversation not found.', 404);
  }
  if (!previous.exists) {
    await ref.set({
      conversationId,
      customerId: user?.uid || null,
      customerName: user?.name || user?.displayName || 'Website visitor',
      customerEmail: user?.email || '',
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
  }

  const currentStatus = previous.exists ? String(previous.data().status || 'OPEN') : 'OPEN';
  const pendingAccountAction = String(previous.data()?.pendingAccountAction || '');
  const isVerificationCodeReply = pendingAccountAction === 'verify_email' && /^\d{6}$/.test(message) && Boolean(user?.uid);

  if (!isVerificationCodeReply) {
    await ref.collection('messages').add({
      role: 'user',
      content: pendingAccountAction === 'verify_email' && /^\d{6}$/.test(message) ? '[verification code submitted]' : message,
      createdAt: FieldValue.serverTimestamp()
    });
  }

  // ====== Existing: handoff to human support ======
  if (currentStatus === 'IN_PROGRESS' || currentStatus === 'NEEDS_SUPPORT') {
    await ref.set({ lastMessage: message, messageCount: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    const ticketId = previous.exists ? String(previous.data().ticketId || '') : '';
    await ref.collection('messages').add({ role: 'admin', content: 'Message received. A HerStep support agent will reply here.', createdAt: FieldValue.serverTimestamp() });
    await adminDb.collection('supportTickets').doc(`ai_${conversationId}`).set({
      ticketId: ticketId || `AI-${conversationId.slice(0, 8).toUpperCase()}`,
      customerId: user?.uid || null,
      customerName: user?.name || user?.displayName || 'Website visitor',
      customerEmail: user?.email || '',
      subject: 'Aria chat needs human support',
      category: /payment|pay|mpesa|stk/i.test(message) ? 'Payment Issue' : /delivery|shipping/i.test(message) ? 'Delivery Issue' : /order|refund|cancel/i.test(message) ? 'Order Issue' : 'General Enquiry',
      conversationId,
      status: currentStatus === 'IN_PROGRESS' ? 'IN_PROGRESS' : 'OPEN',
      lastMessage: message,
      lastMessageAt: FieldValue.serverTimestamp(),
      lastMessageSenderRole: 'CUSTOMER',
      hasUnreadAdminMessages: true,
      messageCount: FieldValue.increment(1),
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    return res.status(200).json({
      conversationId,
      reply: 'Your message has been sent to HerStep Support. A team member will reply in this chat. Please keep this window open.',
      products: [],
      agentJoined: true,
      needsHuman: true,
      ticketId: ticketId || `AI-${conversationId.slice(0, 8).toUpperCase()}`
    });
  }

  // ====== Existing: verification code reply ======
  if (isVerificationCodeReply) {
    try {
      const result = await confirmVerifyCode({
        db: adminDb,
        now: Date.now(),
        verifyKey: () => verifyKey(process.env),
        markAuthEmailVerified: uid => adminAuth.updateUser(uid, { emailVerified: true })
      }, user, { code: message });
      const reply = result?.verified ? 'Your email is now verified — you’re all set!' : 'I couldn’t confirm that code. Please try again.';
      await ref.set({
        pendingAccountAction: result?.verified ? null : 'verify_email',
        lastMessage: '[verification code submitted]',
        lastReply: reply,
        messageCount: FieldValue.increment(1),
        updatedAt: FieldValue.serverTimestamp()
      }, { merge: true });
      await ref.collection('messages').add({ role: 'assistant', content: reply, createdAt: FieldValue.serverTimestamp() });
      return res.status(200).json({ conversationId, reply, products: [], actions: [], needsHuman: false });
    } catch (error) {
      const reply = String(error?.message || 'That code could not be confirmed. Please request a new verification code if it has expired.');
      await ref.set({ lastMessage: '[verification code submitted]', lastReply: reply, messageCount: FieldValue.increment(1), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      await ref.collection('messages').add({ role: 'assistant', content: reply, createdAt: FieldValue.serverTimestamp() });
      return res.status(200).json({ conversationId, reply, products: [], actions: [], needsHuman: false });
    }
  }

  // ====== Existing: explicit human request ======
  if (explicitlyRequestsHuman(message)) {
    const ticketId = previous.exists && previous.data().ticketId ? String(previous.data().ticketId) : `AI-${conversationId.slice(0, 8).toUpperCase()}`;
    const reply = `Of course — I’ll pass this conversation to HerStep Support. Your message and chat history are saved, so you won’t need to repeat yourself. Ticket: ${ticketId}. A team member will reply here. If you need help sooner, WhatsApp https://wa.me/254106624924 or email herstepcollection@gmail.com.`;
    await ref.set({
      conversationId,
      status: 'NEEDS_SUPPORT',
      ticketId,
      agentJoined: false,
      lastMessage: message,
      lastReply: reply,
      messageCount: FieldValue.increment(2),
      updatedAt: FieldValue.serverTimestamp(),
      ...(previous.exists ? {} : { createdAt: FieldValue.serverTimestamp() })
    }, { merge: true });
    await ref.collection('messages').add({ role: 'assistant', content: reply, productIds: [], needsHuman: true, createdAt: FieldValue.serverTimestamp() });
    await adminDb.collection('supportTickets').doc(`ai_${conversationId}`).set({
      ticketId,
      customerId: user?.uid || null,
      customerName: user?.name || user?.displayName || 'Website visitor',
      customerEmail: user?.email || '',
      subject: 'Customer requested a human support agent',
      category: /payment|pay|mpesa|stk/i.test(message) ? 'Payment Issue' : /delivery|shipping/i.test(message) ? 'Delivery Issue' : /order|refund|cancel/i.test(message) ? 'Order Issue' : 'General Enquiry',
      handoffReason: 'Customer explicitly requested a human agent',
      conversationId,
      status: 'OPEN',
      lastMessage: message,
      lastMessageAt: FieldValue.serverTimestamp(),
      lastMessageSenderRole: 'CUSTOMER',
      hasUnreadAdminMessages: true,
      messageCount: FieldValue.increment(2),
      ...(previous.exists ? {} : { createdAt: FieldValue.serverTimestamp() }),
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    return res.status(200).json({
      conversationId, reply, products: [], needsHuman: true, ticketId,
      supportContacts: { whatsapp: 'https://wa.me/254106624924', email: 'herstepcollection@gmail.com', phone: '+254799021089' }
    });
  }

  // ====== Existing: account intent (order/payment/invoice/verification) ======
  const accountIntent = detectAriaAccountIntent(message);
  if (accountIntent) {
    if (accountIntent === 'payment' && user?.uid) {
      await reconcileBestEffort(adminDb, { customerId: user.uid }).catch(error => console.error('[Aria account] payment reconcile failed:', error?.message || error));
    }
    const accountResult = await resolveAriaAccountIntent({
      db: adminDb, user, message,
      sendVerification: verifiedUser => sendVerifyCode({
        db: adminDb, now: Date.now(), waitUntil, deliverQueuedEmailInline,
        verifySenderConfigured: () => verifySenderConfigured(emailConfig()),
        verifyKey: () => verifyKey(process.env),
        markAuthEmailVerified: uid => adminAuth.updateUser(uid, { emailVerified: true })
      }, verifiedUser, {}),
      confirmVerification: (verifiedUser, code) => confirmVerifyCode({
        db: adminDb, now: Date.now(),
        verifyKey: () => verifyKey(process.env),
        markAuthEmailVerified: uid => adminAuth.updateUser(uid, { emailVerified: true })
      }, verifiedUser, { code }),
      sendInvoice: ({ uid, orderDocumentId, email }) => emailInvoiceToRecipientCore({ db: adminDb, uid, orderDocumentId, email }),
      conversationState: { pendingAccountAction }
    });
    const accountReply = String(accountResult?.reply || 'I couldn’t retrieve that account information just now. Please try again or contact HerStep Support.');
    const actions = Array.isArray(accountResult?.actions) ? accountResult.actions : [];
    const nextPendingAction = accountResult?.clearPendingAction ? null : (accountResult?.nextAction === 'verify_email' || accountResult?.keepPendingAction ? 'verify_email' : null);
    await ref.set({
      status: 'OPEN',
      lastMessage: isVerificationCodeReply ? '[verification code submitted]' : message,
      lastReply: accountReply,
      pendingAccountAction: nextPendingAction,
      messageCount: FieldValue.increment(2),
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    await ref.collection('messages').add({ role: 'assistant', content: accountReply, actions, createdAt: FieldValue.serverTimestamp() });
    return res.status(200).json({ conversationId, reply: accountReply, products: [], actions, needsHuman: false });
  }

  // ========================
  // NEW: Profile-aware memory
  // ========================
  const profileUpdates = extractProfileInfo(message);
  if (user?.uid && Object.keys(profileUpdates).length) {
    await updateProfile(user.uid, profileUpdates);
  }
  const profile = user?.uid ? await getProfile(user.uid) : {};
  const profileContext = buildProfileContext(profile);

  // ========================
  // FRIENDLIER SCOPE / GREETING CHECK
  // ========================
  const replyOutOfScope = "I'm Aria, your HerStep shopping assistant 💕 I mostly help with shoes, sizes, styles, orders and delivery — but I'm happy to chat! What are you shopping for today?";

  const historySnap = await ref.collection('messages').orderBy('createdAt', 'desc').limit(12).get();
  const recentHistory = historySnap.docs.map(d => ({
    role: d.data().role,
    content: String(d.data().content || '')
  })).reverse();

  const hasRelevantContext = recentHistory.slice(-6).some(m => /order|payment|invoice|verification|verify|code|delivery|tracking|support|shoe|size|price|stock/i.test(m.content));
  const contextualFollowUp = hasRelevantContext && (
    message.length < 100 ||
    /\b(this|that|it|they|those|these|one|already|yes|no|both|do that|send it|help me|the first|the second|what about|i have|received|got it)\b/i.test(message)
  );

  const isGreeting = greeting.test(message.trim());
  const isConversational = conversational.test(message);

  if (!scope.test(message) && !isGreeting && !isConversational && !contextualFollowUp) {
    await ref.set({
      status: 'OPEN',
      lastMessage: message,
      lastReply: replyOutOfScope,
      messageCount: FieldValue.increment(2),
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
    await ref.collection('messages').add({ role: 'assistant', content: replyOutOfScope, productIds: [], createdAt: FieldValue.serverTimestamp() });
    return res.status(200).json({ conversationId, reply: replyOutOfScope, products: [], needsHuman: false });
  }

  // ====== Existing: catalogue load ======
  const snap = await adminDb.collection('products').where('status', '==', 'ACTIVE').limit(1000).get();
  const allProducts = snap.docs.map(d => {
    const p = d.data();
    const inv = Array.isArray(p.inventory) ? p.inventory.filter(x => x && Number(x.quantity) > 0) : [];
    return {
      id: d.id,
      name: String(p.name || ''),
      sku: String(p.sku || ''),
      description: String(p.description || '').slice(0, 400),
      categoryId: String(p.categoryId || ''),
      price: Number(p.salePrice) > 0 && Number(p.salePrice) < Number(p.price) ? Number(p.salePrice) : Number(p.price || 0),
      regularPrice: Number(p.price || 0),
      inventory: inv.map(x => ({ size: String(x.size), quantity: Number(x.quantity) })),
      sizes: inv.map(x => String(x.size)),
      image: Array.isArray(p.images) ? (p.images[0]?.url || '') : '',
      featured: !!p.featured,
      bestseller: !!p.bestseller,
      newArrival: !!p.newArrival
    };
  }).filter(p => p.name);

  // Full list kept for cheapest-shoe logic
  const products = allProducts;

  // Trimmed list sent to the AI to stay under Groq token limits
  const catalogueForAI = pickRelevantProducts(allProducts, message);

  const history = historySnap.docs.slice().reverse().map(d => ({
    role: ['assistant', 'admin'].includes(d.data().role) ? 'assistant' : 'user',
    content: String(d.data().content || '').slice(0, 1000)
  }));

  // ====== Existing: cheapest shoe logic (uses full catalogue) ======
  const cheapestIntent = /\b(?:cheapest|cheaper|lowest priced|lowest price|least expensive|most affordable|cheapest one|cheapest shoes)\b/i.test(message);
  if (cheapestIntent) {
    const stocked = products.filter(p => p.inventory.length > 0 && Number.isFinite(p.price) && p.price > 0).sort((a, b) => a.price - b.price || a.name.localeCompare(b.name));
    const cheapest = stocked.slice(0, 4);
    const priorRecommended = historySnap.docs.find(d => d.data().role === 'assistant' && Array.isArray(d.data().productIds) && d.data().productIds.length)?.data().productIds || [];
    const followUp = /\b(?:this|that|it|they|those|these|one)\b/i.test(message) && /\b(?:cheapest|cheaper|lowest|least expensive)\b/i.test(message);
    let verifiedReply = '';
    if (!cheapest.length) verifiedReply = 'I checked the current catalogue, but I can’t confirm an in-stock shoe price right now. Please try again shortly or contact HerStep Support.';
    else if (followUp && priorRecommended.length) verifiedReply = priorRecommended.includes(cheapest[0].id) ? 'Yes — the shoe I recommended is currently the lowest-priced in-stock option at KSh ' + cheapest[0].price.toLocaleString() + '. I checked the live catalogue.' : 'Good question — I verified against the live catalogue. The cheapest in-stock option is ' + cheapest[0].name + ' at KSh ' + cheapest[0].price.toLocaleString() + (cheapest[1] ? '; the next is ' + cheapest[1].name + ' at KSh ' + cheapest[1].price.toLocaleString() : '') + '. The earlier recommendation was not the cheapest. I’m sorry about that.';
    else verifiedReply = 'I checked the live HerStep catalogue and sorted shoes with stock by price. The cheapest in-stock options are: ' + cheapest.map(p => p.name + ' — KSh ' + p.price.toLocaleString()).join('; ') + '. These prices come from the current product records.';
    const verifiedIds = cheapest.map(p => p.id);
    await ref.set({ status: 'OPEN', lastMessage: message, lastReply: verifiedReply, messageCount: FieldValue.increment(2), updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    await ref.collection('messages').add({ role: 'assistant', content: verifiedReply, productIds: verifiedIds, createdAt: FieldValue.serverTimestamp() });
    return res.status(200).json({
      conversationId, reply: verifiedReply,
      products: cheapest.map(p => ({
        id: p.id, name: p.name, sku: p.sku, price: p.price, regularPrice: p.regularPrice,
        sizes: p.sizes, inventory: p.inventory, image: p.image, href: '/product/' + p.id,
        featured: p.featured, bestseller: p.bestseller, newArrival: p.newArrival
      })),
      needsHuman: false
    });
  }

  // ====== Existing: Groq call (prompt trimmed + trimmed catalogue) ======
  const key = String(process.env.GROQ_API_KEY || '').trim();
  let reply = '', ids = [], needsHuman = false;

  if (key) {
    const prompt = `You are Aria, the warm, friendly, human-like shopping assistant for HerStep Collection (Kenyan ladies' shoes).${profileContext}

IDENTITY: You are Aria. Say "I'm Aria" if asked. Only say you're an AI if the customer directly asks if you're a bot/AI/human. Never rename yourself.

PERSONALITY: Warm, feminine, patient, confident, like a personal stylist. Use natural language with occasional emojis 👠💕. NEVER sound like a FAQ machine. NEVER repeat the same greeting twice. NEVER ask for info you already have (name/size/occasion/budget). Use the customer's name if known.

CONVERSATION: Handle greetings, small talk ("how are you", "what's your name"), and gentle off-topic questions briefly, then return to shopping naturally. Only redirect genuinely unrelated topics (recipes, politics, homework) — warmly, not robotically. Treat short follow-ups like "is this the cheapest?", "what about that one?", "why?", "are you sure?" in context.

FACTS: Use ONLY the live catalogue for product facts. Never invent products, prices, SKUs, stock, sizes, links, policies or materials. Recommend only in-stock sizes. Links: /product/{id}. If nothing matches, be honest and offer alternatives. If human help is needed, set needsHuman=true (don't claim a ticket was made).

Return JSON only: {"reply":"...","productIds":["exact ids from catalogue, max 4"],"needsHuman":false}.
CATALOGUE:\n${JSON.stringify(catalogueForAI.map(({ id, name, sku, description, price, regularPrice, sizes, featured, bestseller, newArrival }) => ({ id, name, sku, description: description.slice(0, 150), price, regularPrice, sizes, featured, bestseller, newArrival })))}`;

    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: String(process.env.GROQ_CHAT_MODEL || 'llama-3.1-8b-instant').trim(),
          temperature: 0.4,
          max_tokens: 500,
          response_format: { type: 'json_object' },
          messages: [{ role: 'system', content: prompt }, ...history.slice(-4)]
        }),
        signal: AbortSignal.timeout(20000)
      });
      if (response.ok) {
        const data = await response.json();
        const parsed = JSON.parse(data.choices[0].message.content);
        reply = clean(parsed.reply);
        ids = Array.isArray(parsed.productIds) ? parsed.productIds.filter(id => products.some(p => p.id === id)).slice(0, 4) : [];
        needsHuman = needsHuman || parsed.needsHuman === true;
      } else {
        const errText = (await response.text()).slice(0, 250);
        console.error('HerStep AI assistant model error:', response.status, errText);
      }
    } catch (e) {
      console.error('HerStep AI assistant request failed:', String(e).slice(0, 200));
    }
  }

  // ====== Warmer, non-repeating fallback ======
  if (!reply) {
    const firstName = profile.name ? ', ' + profile.name : '';
    const sizeHint = profile.shoeSize ? ` I remember you're a size ${profile.shoeSize}.` : '';
    const occasionHint = profile.occasion ? ` Looking for ${profile.occasion} shoes?` : '';

    if (isGreeting) {
      reply = `Hi${firstName}! 👋💕 I'm Aria — lovely to see you.${sizeHint}${occasionHint} What are you shopping for today?`;
    } else if (isConversational) {
      reply = `I'm Aria, your HerStep shopping assistant 💕 I'm doing great, thank you for asking! Tell me the occasion, style, colour, or budget and I'll find you something lovely.${sizeHint}`;
    } else if (products.length) {
      reply = `Hi${firstName}! 💕 I'm here to help you find the perfect pair.${sizeHint} Tell me the occasion, style, colour, or budget and I'll pull up some options.`;
    } else {
      reply = `Hi${firstName}! 💕 Our live catalogue is loading right now — try again in a moment, or tell me what you're looking for and I'll help as soon as it's back.`;
    }
    ids = [];
  }

  const chosen = products.filter(p => ids.includes(p.id));
  const ticketId = needsHuman ? `AI-${conversationId.slice(0, 8).toUpperCase()}` : null;

  await ref.set({
    conversationId,
    status: needsHuman ? 'NEEDS_SUPPORT' : 'OPEN',
    ...(needsHuman ? { ticketId, agentJoined: false } : {}),
    lastMessage: message,
    lastReply: reply,
    messageCount: FieldValue.increment(2),
    updatedAt: FieldValue.serverTimestamp(),
    ...(previous.exists ? {} : { createdAt: FieldValue.serverTimestamp() })
  }, { merge: true });

  await ref.collection('messages').add({
    role: 'assistant',
    content: needsHuman ? reply + '\n\nYour support request has been opened. Ticket: ' + ticketId + '\n' + contactText : reply,
    productIds: ids,
    needsHuman,
    createdAt: FieldValue.serverTimestamp()
  });

  if (needsHuman) {
    await adminDb.collection('supportTickets').doc(`ai_${conversationId}`).set({
      ticketId,
      customerId: user?.uid || null,
      customerName: user?.name || user?.displayName || 'Website visitor',
      customerEmail: user?.email || '',
      subject: 'Aria chat needs human support',
      category: /payment|pay|mpesa|stk/i.test(message) ? 'Payment Issue' : /delivery|shipping/i.test(message) ? 'Delivery Issue' : /order|refund|cancel/i.test(message) ? 'Order Issue' : 'General Enquiry',
      conversationId,
      status: 'OPEN',
      lastMessage: message,
      lastMessageAt: FieldValue.serverTimestamp(),
      lastMessageSenderRole: 'CUSTOMER',
      hasUnreadAdminMessages: true,
      messageCount: FieldValue.increment(2),
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp()
    }, { merge: true });
  }

  return res.status(200).json({
    conversationId,
    reply: needsHuman ? reply + '\n\nYour support request has been opened. Ticket: ' + ticketId + '\n' + contactText : reply,
    products: chosen.map(p => ({
      id: p.id, name: p.name, sku: p.sku, price: p.price, regularPrice: p.regularPrice,
      sizes: p.sizes, inventory: p.inventory, image: p.image, href: `/product/${p.id}`,
      featured: p.featured, bestseller: p.bestseller, newArrival: p.newArrival
    })),
    needsHuman,
    ticketId,
    supportContacts: needsHuman ? { whatsapp: 'https://wa.me/254106624924', email: 'herstepcollection@gmail.com', phone: '+254799021089' } : null
  });
}
