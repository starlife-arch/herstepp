import { FieldValue } from 'firebase-admin/firestore';
import { adminDb, requireUser, requireAdmin } from '../firebase-admin.js';
import { clientError, methodNotAllowed } from '../http.js';

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
    return { id: ref.id, ticketId: `SUP-${String(sequence).padStart(6, '0')}` };
  });
  return res.status(201).json({ ticket: result });
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
export async function adminStatus(req, res) { if (req.method !== 'PATCH') return methodNotAllowed(res, 'PATCH'); const admin = await requireAdmin(req); const { ticketDocumentId, status } = req.body || {}; await adminDb.runTransaction(async tx => { const ref = adminDb.collection('supportTickets').doc(ticketDocumentId); const snap = await tx.get(ref); if (!snap.exists) throw clientError('Ticket not found.', 404); const old = snap.data().status; if (!statusMoves[old]?.includes(status)) throw clientError('This support ticket status cannot be changed that way.', 409); tx.update(ref, { status, updatedAt: FieldValue.serverTimestamp() }); tx.set(ref.collection('history').doc(`${old}-${status}`), { previousStatus: old, newStatus: status, adminId: admin.uid, adminName: admin.displayName || admin.email || '', createdAt: FieldValue.serverTimestamp() }); }); return res.json({ ok: true }); }
export async function adminRead(req, res) { if (req.method !== 'POST') return methodNotAllowed(res, 'POST'); await requireAdmin(req); await adminDb.collection('supportTickets').doc(req.body?.ticketDocumentId).update({ hasUnreadAdminMessages: false, updatedAt: FieldValue.serverTimestamp() }); return res.json({ ok: true }); }
export async function adminNotes(req, res) { const admin = await requireAdmin(req); if (req.method === 'GET') { const snap = await adminDb.collection('supportTickets').doc(req.query?.ticketDocumentId).collection('internalNotes').limit(100).get(); return res.json({ notes: snap.docs.map(doc => ({ id: doc.id, ...doc.data(), createdAt: iso(doc.data().createdAt) })) }); } if (req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']); const { ticketDocumentId, body } = req.body || {}; if (typeof body !== 'string' || !body.trim() || body.length > 4000) throw clientError('Provide a valid note.'); await adminDb.collection('supportTickets').doc(ticketDocumentId).collection('internalNotes').add({ body: body.trim(), authorId: admin.uid, authorName: admin.displayName || admin.email || '', createdAt: FieldValue.serverTimestamp() }); return res.status(201).json({ ok: true }); }

export async function adminMessage(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
  const admin = await requireAdmin(req);
  const body = req.body || {};
  const input = messageInput(body);
  await adminDb.runTransaction(async tx => {
    const ref = adminDb.collection('supportTickets').doc(body.ticketDocumentId);
    const ticket = await tx.get(ref);
    if (!ticket.exists) throw clientError('Ticket not found.', 404);
    if (ticket.data().status === 'CLOSED') throw clientError('This support ticket has been closed.', 409);
    const messageRef = ref.collection('messages').doc(body.clientMessageId);
    if ((await tx.get(messageRef)).exists) return;
    const senderName = admin.displayName || admin.email || '';
    tx.set(messageRef, { senderId: admin.uid, senderName, senderRole: 'ADMIN', body: input.text, attachments: input.files, createdAt: FieldValue.serverTimestamp() });
    tx.update(ref, { lastMessage: input.text, lastMessageAt: FieldValue.serverTimestamp(), lastMessageSenderRole: 'ADMIN', messageCount: Number(ticket.data().messageCount || 1) + 1, updatedAt: FieldValue.serverTimestamp() });
  });
  return res.json({ ok: true });
}
