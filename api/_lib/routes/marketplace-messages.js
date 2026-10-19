import { FieldValue } from 'firebase-admin/firestore';
import { adminDb, requireUser } from '../firebase-admin.js';
import { clientError, methodNotAllowed } from '../http.js';

const clean = value => String(value ?? '').trim();
const MAX_MESSAGE = 2000;

function serialize(value) {
  if (value?.toDate) return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(serialize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, serialize(v)]));
  return value;
}

async function getConversationForParticipant(id, uid) {
  if (!id || id.length > 150) throw clientError('A valid conversation is required.');
  const ref = adminDb.collection('sellerMarketplaceConversations').doc(id);
  const snap = await ref.get();
  if (!snap.exists) throw clientError('Conversation not found.', 404);
  const conversation = snap.data() || {};
  if (conversation.customerUid !== uid && conversation.sellerUid !== uid) {
    throw clientError('You do not have access to this conversation.', 403);
  }
  return { ref, conversation };
}

export default async function sellerMarketplaceMessages(req, res) {
  const user = await requireUser(req);

  if (req.method === 'GET') {
    const conversationId = clean(req.query?.conversationId);
    if (conversationId) {
      const { ref, conversation } = await getConversationForParticipant(conversationId, user.uid);
      const snapshot = await ref.collection('messages').orderBy('createdAt', 'desc').limit(100).get();
      const messages = snapshot.docs.map(doc => serialize({ id: doc.id, ...doc.data() })).reverse();
      await ref.update({
        ...(conversation.customerUid === user.uid ? { customerLastReadAt: FieldValue.serverTimestamp() } : {}),
        ...(conversation.sellerUid === user.uid ? { sellerLastReadAt: FieldValue.serverTimestamp() } : {}),
      });
      return res.status(200).json({ conversation: serialize({ id: conversationId, ...conversation }), messages });
    }

    const [customerRows, sellerRows] = await Promise.all([
      adminDb.collection('sellerMarketplaceConversations').where('customerUid', '==', user.uid).limit(100).get(),
      adminDb.collection('sellerMarketplaceConversations').where('sellerUid', '==', user.uid).limit(100).get(),
    ]);
    const unique = new Map();
    for (const doc of [...customerRows.docs, ...sellerRows.docs]) unique.set(doc.id, serialize({ id: doc.id, ...doc.data() }));
    const conversations = [...unique.values()].sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    return res.status(200).json({ conversations });
  }

  if (req.method !== 'POST') return methodNotAllowed(res, 'GET, POST');
  const action = clean(req.body?.action || 'message').toLowerCase();

  if (action === 'start') {
    const productId = clean(req.body?.productId);
    if (!productId || productId.length > 150) throw clientError('A valid product is required.');
    const productSnap = await adminDb.collection('products').doc(productId).get();
    if (!productSnap.exists) throw clientError('Product not found.', 404);
    const product = productSnap.data() || {};
    const sellerUid = clean(product.sellerUid);
    if (!sellerUid || String(product.status || '').toUpperCase() !== 'ACTIVE') {
      throw clientError('Messaging is available only for active marketplace listings.', 404);
    }
    if (sellerUid === user.uid) throw clientError('You cannot message yourself about your own listing.');
    const sellerSnap = await adminDb.collection('sellers').doc(sellerUid).get();
    const seller = sellerSnap.data() || {};
    const expiry = seller.subscriptionExpiresAt?.toDate ? seller.subscriptionExpiresAt.toDate() : new Date(seller.subscriptionExpiresAt || 0);
    if (!sellerSnap.exists || seller.status !== 'ACTIVE' || seller.billingStatus !== 'ACTIVE' || !Number.isFinite(expiry.getTime()) || expiry.getTime() <= Date.now()) {
      throw clientError('This seller is not currently available for messaging.', 404);
    }

    const prior = await adminDb.collection('sellerMarketplaceConversations')
      .where('customerUid', '==', user.uid).limit(200).get();
    const existing = prior.docs.find(doc => {
      const data = doc.data() || {};
      return data.productId === productId && data.sellerUid === sellerUid && data.status === 'OPEN';
    });
    if (existing) return res.status(200).json({ conversationId: existing.id, existing: true });

    const ref = await adminDb.collection('sellerMarketplaceConversations').add({
      productId,
      productName: clean(product.name).slice(0, 160),
      productImage: clean(product.images?.[0]?.url).startsWith('https://') ? clean(product.images[0].url) : '',
      customerUid: user.uid,
      sellerUid,
      sellerDisplayName: clean(seller.displayName || seller.businessName).slice(0, 100),
      status: 'OPEN',
      lastMessage: '',
      lastMessageAt: FieldValue.serverTimestamp(),
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      customerLastReadAt: FieldValue.serverTimestamp(),
    });
    return res.status(201).json({ conversationId: ref.id, existing: false });
  }

  if (action !== 'message') throw clientError('Choose a valid messaging action.');
  const conversationId = clean(req.body?.conversationId);
  const message = clean(req.body?.message);
  if (!message || message.length > MAX_MESSAGE) throw clientError('Message must be between 1 and 2,000 characters.');
  const { ref, conversation } = await getConversationForParticipant(conversationId, user.uid);
  if (conversation.status !== 'OPEN') throw clientError('This conversation is closed.');
  const messageRef = await ref.collection('messages').add({
    senderUid: user.uid,
    senderRole: user.uid === conversation.sellerUid ? 'SELLER' : 'CUSTOMER',
    text: message,
    createdAt: FieldValue.serverTimestamp(),
  });
  await ref.update({
    lastMessage: message.slice(0, 240),
    lastMessageAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
    ...(user.uid === conversation.customerUid ? { customerLastReadAt: FieldValue.serverTimestamp() } : { sellerLastReadAt: FieldValue.serverTimestamp() }),
  });
  await adminDb.collection('sellerMarketplaceAudit').add({
    action: 'MARKETPLACE_MESSAGE_SENT',
    conversationId,
    actorUid: user.uid,
    createdAt: FieldValue.serverTimestamp(),
  });
  return res.status(201).json({ success: true, messageId: messageRef.id });
}
