import { FieldValue } from 'firebase-admin/firestore';
import { waitUntil } from '@vercel/functions';
import { adminDb, requireUser, requireAdmin } from '../firebase-admin.js';
import { clientError, methodNotAllowed } from '../http.js';
import { queueEmail, deliverQueuedEmailInline } from '../email-service.js';
import { buildEmail } from '../email-templates.js';
import { sendTelegramMessage } from '../telegram.js';
import { siteUrl } from '../site-url.js';

const SUPPORT_DISPLAY_NAME = 'HerStep Support';
const safeAgentProfile = (data, admin) => ({ agentId: admin.uid, name: String(data?.supportDisplayName || admin.displayName || admin.email || 'HerStep Support').trim().slice(0, 60), photoURL: typeof data?.supportPhotoURL === 'string' && /^https:\/\//i.test(data.supportPhotoURL) ? data.supportPhotoURL : '' });
const categories = new Set(['Order Issue', 'Payment Issue', 'Delivery Issue', 'Product Issue', 'Return/Exchange', 'General Enquiry', 'Other']);
const msgRe = /^[A-Za-z0-9_-]{8,80}$/;
const createHits = new Map();
const statusMoves = { OPEN: ['IN_PROGRESS', 'WAITING_FOR_CUSTOMER', 'RESOLVED', 'CLOSED'], IN_PROGRESS: ['WAITING_FOR_CUSTOMER', 'RESOLVED', 'CLOSED'], WAITING_FOR_CUSTOMER: ['IN_PROGRESS', 'RESOLVED', 'CLOSED'], RESOLVED: ['IN_PROGRESS', 'WAITING_FOR_CUSTOMER', 'CLOSED'], CLOSED: [] };
const iso = value => value?.toDate ? value.toDate().toISOString() : value || null;

function attachments(value) {
  if (!Array.isArray(value) || value.length > 3) throw clientError('You can attach up to three images.');
  const cloud = String(process.env.CLOUDINARY_CLOUD_NAME || '').trim();
  const prefix = `https://res.cloudinary.com/${cloud}/image/upload/`;
  return value.map(file => {
    if (!file || file.type !== 'image' || typeof file.url !== 'string' || typeof file.publicId !== 'string' || !file.url.startsWith(prefix) || !file.publicId.startsWith('herstep/support/')) throw clientError('Support attachments must be uploaded support images.');
    return { url: file.url, publicId: file.publicId, type: 'image' };
  });
}

function messageInput(body) {
  const text = typeof body.message === 'string' ? body.message.trim() : '';
  const files = attachments(body.attachments || []);
  if ((!text && !files.length) || text.length > 4000 || !msgRe.test(body.clientMessageId || '')) throw clientError('Provide a valid message or attachment and message id.');
  return { text, files };
}

export async function create(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
  const user = await requireUser(req);
  const body = req.body || {};
  if (Object.keys(body).some(key => !['subject', 'message', 'category', 'attachments', 'orderDocumentId', 'clientMessageId'].includes(key))) throw clientError('Unknown support field.');
  const input = messageInput(body);
  if (typeof body.subject !== 'string' || body.subject.trim().length < 3 || body.subject.trim().length > 140) throw clientError('Subject must be 3 to 140 characters.');
  if (!categories.has(body.category)) throw clientError('Choose a category.');
  const now = Date.now();
  const hits = (createHits.get(user.uid) || []).filter(at => now - at < 600000);
  if (hits.length >= 3) throw clientError('Too many support tickets. Please wait before creating another.', 429);
  hits.push(now); createHits.set(user.uid, hits);
  const result = await adminDb.runTransaction(async tx => {
    const profile = await tx.get(adminDb.collection('users').doc(user.uid));
    if (body.orderDocumentId) {
      const order = await tx.get(adminDb.collection('orders').doc(body.orderDocumentId));
      if (!order.exists || order.data().customerId !== user.uid) throw clientError('That order does not belong to you.', 403);
    }
    const counter = adminDb.collection('counters').doc('supportTickets');
    const counterSnap = await tx.get(counter);
    const sequence = Number(counterSnap.exists ? counterSnap.data().sequence : 0) + 1;
    const ref = adminDb.collection('supportTickets').doc();
    const profileData = profile.exists ? profile.data() : {};
    tx.set(counter, { sequence }, { merge: true });
    tx.set(ref, { ticketId: `SUP-${String(sequence).padStart(6, '0')}`, customerId: user.uid, customerName: profileData.displayName || user.displayName || '', customerEmail: profileData.email || user.email || '', subject: body.subject.trim(), category: body.category, orderDocumentId: body.orderDocumentId || null, status: 'OPEN', lastMessage: input.text, lastMessageAt: FieldValue.serverTimestamp(), lastMessageSenderRole: 'CUSTOMER', hasUnreadAdminMessages: true, messageCount: 1, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    tx.set(ref.collection('messages').doc(body.clientMessageId), { senderId: user.uid, senderName: profileData.displayName || user.displayName || '', senderRole: 'CUSTOMER', body: input.text, attachments: input.files, createdAt: FieldValue.serverTimestamp() });
    const ticketId = `SUP-${String(sequence).padStart(6, '0')}`;
    const customerEmail = String(profileData.email || user.email || '').trim().toLowerCase();
    const email = buildEmail(
      `Support ticket created — ${ticketId}`,
      `Hi ${profileData.displayName || user.displayName || 'there'},\n\nYour support ticket has been created successfully.\n\nTicket ID: ${ticketId}\nSubject: ${body.subject.trim()}\nCategory: ${body.category}\nStatus: OPEN\n\nKeep this ticket ID for reference. Our support team will respond as soon as possible.`,
      { ctaLabel: 'View support tickets', ctaUrl: `${siteUrl()}/support` },
    );
    const emailKey = customerEmail ? `${ref.id}-SUPPORT-CREATED-EMAIL` : null;
    if (emailKey) queueEmail(tx, adminDb, { key: emailKey, purpose: 'support', to: customerEmail, subject: email.subject, htmlContent: email.htmlContent });
    return { id: ref.id, ticketId, subject: body.subject.trim(), category: body.category, customerEmail, customerName: profileData.displayName || user.displayName || 'Customer', emailKey };
  });
  const telegramText = `🎫 New HerStep support ticket\nTicket: ${result.ticketId}\nCustomer: ${result.customerName}\nEmail: ${result.customerEmail || 'not available'}\nCategory: ${result.category}\nSubject: ${result.subject}\nOpen the admin dashboard to reply.`;
  waitUntil(Promise.all([
    result.emailKey ? deliverQueuedEmailInline(adminDb, result.emailKey) : Promise.resolve(null),
    sendTelegramMessage(telegramText),
  ]).catch(error => console.error('[support] ticket-created notification failed:', error?.message || error)));
  return res.status(201).json({ ticket: { id: result.id, ticketId: result.ticketId } });
}

export async function list(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
  const user = await requireUser(req);
  const snap = await adminDb.collection('supportTickets').where('customerId', '==', user.uid).limit(100).get();
  return res.json({ tickets: snap.docs.map(doc => ({ id: doc.id, ...doc.data(), lastMessageAt: iso(doc.data().lastMessageAt), createdAt: iso(doc.data().createdAt), updatedAt: iso(doc.data().updatedAt) })).sort((a, b) => String(b.lastMessageAt).localeCompare(String(a.lastMessageAt))) });
}

export async function message(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
  const user = await requireUser(req); const body = req.body || {}; const input = messageInput(body);
  const out = await adminDb.runTransaction(async tx => {
    const ref = adminDb.collection('supportTickets').doc(body.ticketDocumentId); const snap = await tx.get(ref);
    if (!snap.exists || snap.data().customerId !== user.uid) throw clientError('Ticket not found.', 404);
    const ticket = snap.data(); if (ticket.status === 'CLOSED') throw clientError('This support ticket has been closed.', 409);
    const messageRef = ref.collection('messages').doc(body.clientMessageId); const old = await tx.get(messageRef);
    if (old.exists) return { id: messageRef.id };
    tx.set(messageRef, { senderId: user.uid, senderName: user.displayName || '', senderRole: 'CUSTOMER', body: input.text, attachments: input.files, createdAt: FieldValue.serverTimestamp() });
    tx.update(ref, { lastMessage: input.text, lastMessageAt: FieldValue.serverTimestamp(), lastMessageSenderRole: 'CUSTOMER', hasUnreadAdminMessages: true, messageCount: Number(ticket.messageCount || 1) + 1, updatedAt: FieldValue.serverTimestamp() });
    return { id: messageRef.id };
  });
  return res.json({ message: out });
}

export async function adminList(req, res) { if (req.method !== 'GET') return methodNotAllowed(res, 'GET'); await requireAdmin(req); const snap = await adminDb.collection('supportTickets').limit(200).get(); return res.json({ tickets: snap.docs.map(doc => ({ id: doc.id, ...doc.data(), lastMessageAt: iso(doc.data().lastMessageAt), createdAt: iso(doc.data().createdAt), updatedAt: iso(doc.data().updatedAt) })).sort((a, b) => String(b.lastMessageAt).localeCompare(String(a.lastMessageAt))) }); }

export async function agentProfile(req, res) {
  const admin = await requireAdmin(req);
  const ref = adminDb.collection('users').doc(admin.uid);
  if (req.method === 'GET') { const snap = await ref.get(); return res.json({ profile: safeAgentProfile(snap.exists ? snap.data() : {}, admin) }); }
  if (req.method !== 'PUT' && req.method !== 'POST') return methodNotAllowed(res, ['GET', 'PUT']);
  const body = req.body || {};
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const photoURL = typeof body.photoURL === 'string' ? body.photoURL.trim() : '';
  if (name.length < 2 || name.length > 60) throw clientError('Agent name must be 2–60 characters.');
  if (photoURL && (!/^https:\/\//i.test(photoURL) || photoURL.length > 1000)) throw clientError('Profile picture must be a valid HTTPS image URL.');
  await ref.set({ supportDisplayName: name, supportPhotoURL: photoURL, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  return res.json({ profile: { agentId: admin.uid, name, photoURL } });
}
export async function adminStatus(req, res) {
  if (req.method !== 'PATCH') return methodNotAllowed(res, 'PATCH');
  const admin = await requireAdmin(req);
  const { ticketDocumentId, status } = req.body || {};
  const result = await adminDb.runTransaction(async tx => {
    const ref = adminDb.collection('supportTickets').doc(ticketDocumentId);
    const snap = await tx.get(ref);
    if (!snap.exists) throw clientError('Ticket not found.', 404);
    const ticket = snap.data();
    const old = ticket.status;
    if (!statusMoves[old]?.includes(status)) throw clientError('This support ticket status cannot be changed that way.', 409);
    tx.update(ref, { status, updatedAt: FieldValue.serverTimestamp() });
    tx.set(ref.collection('history').doc(`${old}-${status}`), { previousStatus: old, newStatus: status, adminId: admin.uid, adminName: admin.displayName || admin.email || '', createdAt: FieldValue.serverTimestamp() });
    let emailKey = null;
    if (['RESOLVED', 'CLOSED'].includes(status) && ticket.customerEmail) {
      const title = status === 'RESOLVED' ? `Support ticket resolved — ${ticket.ticketId}` : `Support ticket closed — ${ticket.ticketId}`;
      const bodyText = status === 'RESOLVED'
        ? `Hi ${ticket.customerName || 'there'},\n\nOur support team has marked ticket ${ticket.ticketId} (“${ticket.subject}”) as resolved. If the issue is still happening, please open a new support ticket and mention this ticket ID so we can help further.\n\nThank you,\nHerStep Support`
        : `Hi ${ticket.customerName || 'there'},\n\nYour support ticket ${ticket.ticketId} (“${ticket.subject}”) has been closed. If the issue is still happening or you need more help, please open a new support ticket and mention this ticket ID.\n\nThank you,\nHerStep Support`;
      const email = buildEmail(title, bodyText, { ctaLabel: 'Open support', ctaUrl: `${siteUrl()}/support` });
      emailKey = `${ticketDocumentId}-SUPPORT-STATUS-${status}-${Date.now()}`;
      queueEmail(tx, adminDb, { key: emailKey, purpose: 'support', to: ticket.customerEmail, subject: email.subject, htmlContent: email.htmlContent });
    }
    return { ticketId: ticket.ticketId, subject: ticket.subject, customerEmail: ticket.customerEmail || '', customerName: ticket.customerName || '', emailKey };
  });
  waitUntil(Promise.all([
    result.emailKey ? deliverQueuedEmailInline(adminDb, result.emailKey) : Promise.resolve(null),
    ['RESOLVED', 'CLOSED'].includes(status) ? sendTelegramMessage(`🎫 Support ticket ${status.toLowerCase()}\nTicket: ${result.ticketId}\nSubject: ${result.subject}\nCustomer: ${result.customerName}\nEmail: ${result.customerEmail || 'not available'}`) : Promise.resolve(null),
  ]).catch(error => console.error('[support] ticket status notification failed:', error?.message || error)));
  return res.json({ ok: true });
}
export async function adminRead(req, res) { if (req.method !== 'POST') return methodNotAllowed(res, 'POST'); await requireAdmin(req); await adminDb.collection('supportTickets').doc(req.body?.ticketDocumentId).update({ hasUnreadAdminMessages: false, updatedAt: FieldValue.serverTimestamp() }); return res.json({ ok: true }); }
export async function adminNotes(req, res) { const admin = await requireAdmin(req); if (req.method === 'GET') { const snap = await adminDb.collection('supportTickets').doc(req.query?.ticketDocumentId).collection('internalNotes').limit(100).get(); return res.json({ notes: snap.docs.map(doc => ({ id: doc.id, ...doc.data(), createdAt: iso(doc.data().createdAt) })) }); } if (req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']); const { ticketDocumentId, body } = req.body || {}; if (typeof body !== 'string' || !body.trim() || body.length > 4000) throw clientError('Provide a valid note.'); await adminDb.collection('supportTickets').doc(ticketDocumentId).collection('internalNotes').add({ body: body.trim(), authorId: admin.uid, authorName: admin.displayName || admin.email || '', createdAt: FieldValue.serverTimestamp() }); return res.status(201).json({ ok: true }); }

export async function adminMessage(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
  const admin = await requireAdmin(req);
  const body = req.body || {};
  const input = messageInput(body);
  const result = await adminDb.runTransaction(async tx => {
    const ref = adminDb.collection('supportTickets').doc(body.ticketDocumentId);
    const ticket = await tx.get(ref);
    if (!ticket.exists) throw clientError('Ticket not found.', 404);
    if (ticket.data().status === 'CLOSED') throw clientError('This support ticket has been closed.', 409);
    const messageRef = ref.collection('messages').doc(body.clientMessageId);
    if ((await tx.get(messageRef)).exists) return { emailKey: null, ticketId: ticket.data().ticketId, customerEmail: ticket.data().customerEmail || '' };
    const agentSnap = await tx.get(adminDb.collection('users').doc(admin.uid));
    const agent = safeAgentProfile(agentSnap.exists ? agentSnap.data() : {}, admin);
    const ticketData = ticket.data();
    const joining = ticketData.assignedAgentId !== admin.uid;
    if (joining) {
      const eventRef = ref.collection('messages').doc(`agent-joined-${admin.uid}-${body.clientMessageId}`);
      tx.set(eventRef, { senderId: admin.uid, senderName: agent.name, senderPhotoURL: agent.photoURL, senderRole: 'SYSTEM', eventType: 'AGENT_JOINED', body: `${agent.name} joined the chat`, attachments: [], createdAt: FieldValue.serverTimestamp() });
    }
    tx.set(messageRef, { senderId: admin.uid, senderName: agent.name, senderPhotoURL: agent.photoURL, senderRole: 'ADMIN', body: input.text, attachments: input.files, createdAt: FieldValue.serverTimestamp() });
    tx.update(ref, { assignedAgentId: admin.uid, assignedAgentName: agent.name, assignedAgentPhotoURL: agent.photoURL, lastMessage: input.text, lastMessageAt: FieldValue.serverTimestamp(), lastMessageSenderRole: 'ADMIN', messageCount: Number(ticketData.messageCount || 1) + 1 + (joining ? 1 : 0), updatedAt: FieldValue.serverTimestamp() });
    // In-app notification so the reply shows in the bell and the Notifications
    // tab. Deterministic doc id (ticket-SUPPORT_REPLY): a replayed request for
    // the same ticket overwrites one doc — never two notifications per reply.
    const customerId = ticket.data().customerId;
    if (customerId) {
      tx.set(adminDb.collection('notifications').doc(`${body.ticketDocumentId}-SUPPORT_REPLY`), {
        customerId,
        orderDocumentId: ticket.data().orderDocumentId || null,
        event: 'SUPPORT_REPLY',
        title: 'New reply on your support ticket',
        body: input.text ? input.text.slice(0, 200) : 'A support agent sent you an attachment.',
        readAt: null,
        createdAt: FieldValue.serverTimestamp(),
      });
    }
    let emailKey = null;
    const customerEmail = String(ticket.data().customerEmail || '').trim().toLowerCase();
    if (customerEmail) {
      const ticketData = ticket.data();
      const email = buildEmail(
        `New reply on support ticket ${ticketData.ticketId}`,
        `Hi ${ticketData.customerName || 'there'},\n\nHerStep Support has replied to your ticket ${ticketData.ticketId} (“${ticketData.subject}”).\n\nReply:\n${input.text || 'The support team sent an attachment.'}\n\nYou can reply from your support page if you need more help.`,
        { ctaLabel: 'View support ticket', ctaUrl: `${siteUrl()}/support` },
      );
      emailKey = `${body.ticketDocumentId}-SUPPORT-REPLY-${body.clientMessageId}`;
      queueEmail(tx, adminDb, { key: emailKey, purpose: 'support', to: customerEmail, subject: email.subject, htmlContent: email.htmlContent });
    }
    return { emailKey, ticketId: ticket.data().ticketId, customerEmail };
  });
  waitUntil((result.emailKey ? deliverQueuedEmailInline(adminDb, result.emailKey) : Promise.resolve(null))
    .catch(error => console.error('[support] reply email failed:', error?.message || error)));
  return res.json({ ok: true });
}
