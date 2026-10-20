// ---------------------------------------------------------------------------
// api/_lib/support-core.js — ALL support-ticket business logic, offline-testable.
//
// Contract (AGENTS.md Phase 2, EXTENDED in this task):
//   supportTickets/{id}: { ticketId 'SUP-000001' (counters/supportTickets.sequence),
//     customerId, customerName, customerEmail, subject 3..140,
//     category (one of SUPPORT_CATEGORIES) | null, orderDocumentId|null,
//     status OPEN|IN_PROGRESS|WAITING_FOR_CUSTOMER|RESOLVED|CLOSED,
//     lastMessage, lastMessageAt, lastMessageSenderRole CUSTOMER|ADMIN,
//     hasUnreadAdminMessages, assignedTo?, createdAt, updatedAt }
//   messages/{clientMessageId}: { senderId, senderRole CUSTOMER|ADMIN,
//     senderName, body <= 4000, attachments [{url, publicId, type:'image'}] max 3,
//     createdAt }  — body OPTIONAL when attachments exist.
//
// Side effects (email + Telegram) are BEST-EFFORT: they run after the Firestore
// commit and NEVER throw into the caller — a broken email service must not stop
// a customer from creating a ticket or sending a message.
//
// All db/notify access goes through `deps` so scripts/test-support-core.mjs can
// run the REAL logic against the in-memory fake Firestore with zero network.
// ---------------------------------------------------------------------------
import { clientError } from './http.js';

export const SUPPORT_STATUSES = ['OPEN', 'IN_PROGRESS', 'WAITING_FOR_CUSTOMER', 'RESOLVED', 'CLOSED'];

// Allowed status moves for ADMIN transitions (CLOSED is final).
export const SUPPORT_STATUS_TRANSITIONS = {
  OPEN: ['IN_PROGRESS', 'WAITING_FOR_CUSTOMER', 'RESOLVED', 'CLOSED'],
  IN_PROGRESS: ['WAITING_FOR_CUSTOMER', 'RESOLVED', 'CLOSED'],
  WAITING_FOR_CUSTOMER: ['IN_PROGRESS', 'RESOLVED', 'CLOSED'],
  RESOLVED: ['IN_PROGRESS', 'WAITING_FOR_CUSTOMER', 'CLOSED'],
  CLOSED: [],
};

// Ticket categories (task contract). Stored as-is (exact string).
export const SUPPORT_CATEGORIES = [
  'Order Issue',
  'Payment Issue',
  'Delivery Issue',
  'Product Issue',
  'Return/Exchange',
  'General Enquiry',
  'Other',
];

export const COLLECTION_PICKUP_LOCATION = 'Juja Town, Jerry House, near Juja Posta, Outside Shop No. 12';

const MAX_ATTACHMENTS = 3;
const MAX_BODY = 4000;

// ---- Validation helpers ----------------------------------------------------
export function validateCategory(value, { required = false } = {}) {
  if (value === undefined || value === null || value === '') {
    if (required) throw clientError('Please choose a category.');
    return null;
  }
  const s = String(value);
  if (!SUPPORT_CATEGORIES.includes(s)) throw clientError('The selected category is not valid.');
  return s;
}

export function validateSubject(value) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (s.length < 3 || s.length > 140) throw clientError('Subject must be between 3 and 140 characters.');
  return s;
}

function validateBody(value, { allowEmpty = false } = {}) {
  if (value === undefined || value === null) {
    if (allowEmpty) return '';
    throw clientError('A message is required.');
  }
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) {
    if (allowEmpty) return '';
    throw clientError('A message is required.');
  }
  if (s.length > MAX_BODY) throw clientError(`Message is too long (max ${MAX_BODY} characters).`);
  return s;
}

/**
 * Validate an attachment list coming from the browser. EVERY url must point at
 * OUR Cloudinary account AND the herstep/support/ folder; every publicId must
 * start with "herstep/support/". Max 3 images. Throws a 400 on anything else.
 */
export function validateAttachments(value, cloudName) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw clientError('Attachments must be a list.');
  if (value.length > MAX_ATTACHMENTS) throw clientError(`You can attach up to ${MAX_ATTACHMENTS} images.`);
  const name = String(cloudName || '').trim();
  if (!name) throw clientError('Image uploads are not configured on the server.', 503);
  const prefix = `https://res.cloudinary.com/${name}/image/upload/`;
  const out = [];
  for (const raw of value) {
    const url = typeof raw?.url === 'string' ? raw.url.trim() : '';
    const publicId = typeof raw?.publicId === 'string' ? raw.publicId.trim() : '';
    // Host check first: any foreign host (even https) is rejected.
    if (!url.startsWith(prefix)) {
      throw clientError('Attachment URL is not from our image server.');
    }
    if (!/^https:\/\/res\.cloudinary\.com\/[^/]+\/image\/upload\/.+/i.test(url)) {
      throw clientError('Attachment URL is not valid.');
    }
    if (!publicId.startsWith('herstep/support/')) {
      throw clientError('Attachment was uploaded to the wrong folder.');
    }
    out.push({ url, publicId, type: 'image' });
  }
  return out;
}

export function sanitizeClientMessageId(value) {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!s) throw clientError('A client message id is required.');
  if (!/^[A-Za-z0-9_-]{6,120}$/.test(s)) throw clientError('The client message id is not valid.');
  return s;
}

// ---- Default deps (production wiring) --------------------------------------
async function defaultLoadDbModule() {
  const mod = await import('./firebase-admin.js');
  return {
    db: mod.currentDb(),
    FieldValue: (await import('firebase-admin/firestore')).FieldValue,
  };
}

async function defaultSendSupportEmail({ to, subject, htmlContent }) {
  try {
    const { sendEmail } = await import('./email-service.js');
    await sendEmail({ purpose: 'support', to, subject, htmlContent });
  } catch (error) {
    console.error('[support] email failed (best-effort):', error?.message || error);
  }
}

async function defaultSendTelegram(text) {
  try {
    const { sendTelegramMessage } = await import('./telegram.js');
    await sendTelegramMessage(text);
  } catch (error) {
    console.error('[support] telegram failed (best-effort):', error?.message || error);
  }
}

export function defaultSupportDeps(overrides = {}) {
  return {
    loadDbModule: defaultLoadDbModule,
    sendSupportEmail: defaultSendSupportEmail,
    sendTelegram: defaultSendTelegram,
    cloudName: () => String(globalThis.process?.env?.CLOUDINARY_CLOUD_NAME || '').trim(),
    siteUrl: () => String(globalThis.process?.env?.SITE_URL || 'https://herstepp.vercel.app').trim(),
    ...overrides,
  };
}

// ---- Core operations --------------------------------------------------------

/**
 * Create a support ticket + its first message atomically.
 * Returns { ticket: {id, ref}, created: true }.
 * Side effects (admin Telegram ping + customer acknowledgement email) run
 * AFTER the commit and can never fail this call.
 */
export async function createTicketCore(deps, { uid, email, displayName, subject, category, body, attachments, orderDocumentId, clientMessageId }) {
  const { db, FieldValue } = await deps.loadDbModule();
  const cleanSubject = validateSubject(subject);
  const cleanCategory = validateCategory(category, { required: true });
  const cleanAttachments = validateAttachments(attachments, deps.cloudName());
  const cleanBody = validateBody(body, { allowEmpty: cleanAttachments.length > 0 });
  if (!cleanBody && cleanAttachments.length === 0) throw clientError('Write a message or attach an image.');
  const cmid = sanitizeClientMessageId(clientMessageId);
  const cleanOrderDocId = typeof orderDocumentId === 'string' && orderDocumentId.trim() ? orderDocumentId.trim().slice(0, 120) : null;

  const ticketRef = db.collection('supportTickets').doc();
  const result = await db.runTransaction(async tx => {
    const counterRef = db.collection('counters').doc('supportTickets');
    const counterSnap = await tx.get(counterRef);
    const sequence = (Number(counterSnap.data()?.sequence) || 0) + 1;
    const ticketId = `SUP-${String(sequence).padStart(6, '0')}`;
    tx.set(counterRef, { sequence }, { merge: true });

    const now = FieldValue.serverTimestamp();
    const message = {
      senderId: uid,
      senderRole: 'CUSTOMER',
      senderName: displayName || email || 'Customer',
      body: cleanBody,
      attachments: cleanAttachments,
      createdAt: now,
    };
    tx.set(ticketRef.collection('messages').doc(cmid), message);
    tx.set(ticketRef, {
      ticketId,
      customerId: uid,
      customerName: displayName || email || 'Customer',
      customerEmail: email || '',
      subject: cleanSubject,
      category: cleanCategory,
      orderDocumentId: cleanOrderDocId,
      status: 'OPEN',
      lastMessage: cleanBody || '(image)',
      lastMessageAt: now,
      lastMessageSenderRole: 'CUSTOMER',
      hasUnreadAdminMessages: true,
      createdAt: now,
      updatedAt: now,
    });
    return { ticketId };
  });

  // ---- best-effort side effects AFTER commit (never throw) -----------------
  const link = `${deps.siteUrl()}/admin`;
  deps.sendTelegram(
    `🎫 New support ticket ${result.ticketId}\n${cleanSubject} (${cleanCategory})\nFrom: ${displayName || email || uid}\n${link}`,
  ).catch(() => {});
  deps.sendSupportEmail({
    to: email || '',
    subject: `We received your support request (${result.ticketId})`,
    htmlContent: `<p>Hi ${displayName || 'there'},</p><p>Thanks for contacting HerStep Collection support. Your request <strong>${result.ticketId}</strong> — “${cleanSubject}” (${cleanCategory}) — has been received and our team will reply here soon.</p><p>Collection pickup: ${COLLECTION_PICKUP_LOCATION}</p>`,
  }).catch(() => {});

  return { id: ticketRef.id, ticketId: result.ticketId, created: true };
}

/**
 * Append a message to a ticket (customer or admin). Idempotent per
 * clientMessageId: resending the same id returns the already-stored message
 * instead of creating a duplicate. CLOSED tickets reject new messages.
 */
export async function addMessageCore(deps, { uid, displayName, role, ticketId, body, attachments, clientMessageId }) {
  const { db, FieldValue } = await deps.loadDbModule();
  const cleanAttachments = validateAttachments(attachments, deps.cloudName());
  const cleanBody = validateBody(body, { allowEmpty: cleanAttachments.length > 0 });
  if (!cleanBody && cleanAttachments.length === 0) throw clientError('Write a message or attach an image.');
  const cmid = sanitizeClientMessageId(clientMessageId);
  const isAdmin = role === 'ADMIN';
  // Admin replies store the admin's displayName; customers their own name.
  const senderName = displayName || (isAdmin ? 'HerStep Support' : 'Customer');

  const ticketRef = db.collection('supportTickets').doc(ticketId);
  const messageRef = ticketRef.collection('messages').doc(cmid);

  const outcome = await db.runTransaction(async tx => {
    const snap = await tx.get(ticketRef);
    if (!snap.exists) throw clientError('Ticket not found.', 404);
    const data = snap.data() || {};
    if (!isAdmin && data.customerId !== uid) throw clientError('Ticket not found.', 404);
    if (data.status === 'CLOSED') throw clientError('This support ticket has been closed.');

    const existing = await tx.get(messageRef);
    if (existing.exists) {
      return { duplicate: true, message: existing.data() };
    }

    const now = FieldValue.serverTimestamp();
    const message = {
      senderId: uid,
      senderRole: isAdmin ? 'ADMIN' : 'CUSTOMER',
      senderName,
      body: cleanBody,
      attachments: cleanAttachments,
      createdAt: now,
    };
    tx.set(messageRef, message);
    tx.update(ticketRef, {
      lastMessage: cleanBody || '(image)',
      lastMessageAt: now,
      lastMessageSenderRole: isAdmin ? 'ADMIN' : 'CUSTOMER',
      // Unread badge tracks NEW customer messages for the admin inbox.
      ...(isAdmin ? {} : { hasUnreadAdminMessages: true }),
      updatedAt: now,
    });
    return { duplicate: false, message, status: data.status, customerEmail: data.customerEmail, ticketNo: data.ticketId };
  });

  if (!outcome.duplicate && !isAdmin) {
    deps.sendTelegram(`💬 New message on ${outcome.ticketNo}: ${(cleanBody || '(image)').slice(0, 300)}`).catch(() => {});
  }
  if (!outcome.duplicate && isAdmin && outcome.customerEmail) {
    deps.sendSupportEmail({
      to: outcome.customerEmail,
      subject: `Support reply on your ticket ${outcome.ticketNo}`,
      htmlContent: `<p>${cleanBody || '(see attached image)'}</p><p>— HerStep Collection Support</p>`,
    }).catch(() => {});
  }

  return { id: messageRef.id, ...outcome.message, duplicate: outcome.duplicate };
}

/**
 * ADMIN: list tickets with their latest 20 messages each (single-field queries
 * only; sorting happens in memory — no composite indexes needed).
 */
export async function listAdminTicketsCore(deps) {
  const { db } = await deps.loadDbModule();
  const snap = await db.collection('supportTickets').limit(200).get();
  const tickets = [];
  for (const docSnap of snap.docs) {
    const messages = await db.collection(`supportTickets/${docSnap.id}/messages`).orderBy('createdAt', 'asc').limit(20).get();
    tickets.push({
      id: docSnap.id,
      ...docSnap.data(),
      messages: messages.docs.map(m => ({ id: m.id, ...m.data() })),
    });
  }
  tickets.sort((a, b) => ts(b.lastMessageAt ?? b.updatedAt) - ts(a.lastMessageAt ?? a.updatedAt));
  return { tickets };
}

/** ADMIN: mark a ticket read (clears the unread badge) and assign it. */
export async function markTicketReadCore(deps, { ticketId, adminId, adminName }) {
  const { db, FieldValue } = await deps.loadDbModule();
  const ref = db.collection('supportTickets').doc(ticketId);
  const snap = await ref.get();
  if (!snap.exists) throw clientError('Ticket not found.', 404);
  await ref.update({
    hasUnreadAdminMessages: false,
    assignedTo: adminId,
    assignedToName: adminName || null,
    updatedAt: FieldValue.serverTimestamp(),
  });
  return { ok: true };
}

/** ADMIN: change status; writes history/{previous-next} like the old live site. */
export async function setTicketStatusCore(deps, { ticketId, adminId, adminName, newStatus }) {
  const { db, FieldValue } = await deps.loadDbModule();
  const next = String(newStatus || '').toUpperCase();
  if (!SUPPORT_STATUSES.includes(next)) throw clientError('The selected status is not valid.');
  const ref = db.collection('supportTickets').doc(ticketId);

  const previous = await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw clientError('Ticket not found.', 404);
    const current = snap.data()?.status || 'OPEN';
    const allowed = SUPPORT_STATUS_TRANSITIONS[current] || [];
    if (!allowed.includes(next)) {
      throw clientError(`Cannot move a ${current} ticket to ${next}.`);
    }
    const now = FieldValue.serverTimestamp();
    tx.set(ref.collection('history').doc(`${current}-${next}`), {
      previousStatus: current,
      newStatus: next,
      adminId,
      adminName: adminName || null,
      createdAt: now,
    });
    tx.update(ref, { status: next, updatedAt: now });
    return current;
  });

  const data = (await ref.get()).data() || {};
  if (data.customerEmail && (next === 'RESOLVED' || next === 'CLOSED')) {
    deps.sendSupportEmail({
      to: data.customerEmail,
      subject: `Your ticket ${data.ticketId} is ${next === 'RESOLVED' ? 'resolved' : 'closed'}`,
      htmlContent: `<p>Your support ticket ${data.ticketId} (“${data.subject || ''}”) has been marked <strong>${next.replace('_', ' ').toLowerCase()}</strong>. You can open a new ticket any time if you need more help.</p>`,
    }).catch(() => {});
  }
  return { previousStatus: previous, newStatus: next };
}

/** ADMIN: internal note (never shown to customers — stored in a subcollection the customer rules do not expose). */
export async function addInternalNoteCore(deps, { ticketId, adminId, adminName, body }) {
  const { db, FieldValue } = await deps.loadDbModule();
  const text = validateBody(body);
  const ref = db.collection('supportTickets').doc(ticketId);
  const snap = await ref.get();
  if (!snap.exists) throw clientError('Ticket not found.', 404);
  const noteRef = ref.collection('internalNotes').doc();
  await noteRef.set({ body: text, authorId: adminId, authorName: adminName || null, createdAt: FieldValue.serverTimestamp() });
  return { id: noteRef.id };
}

/** ADMIN: list internal notes for a ticket. */
export async function listInternalNotesCore(deps, { ticketId }) {
  const { db } = await deps.loadDbModule();
  const ref = db.collection('supportTickets').doc(ticketId);
  const snap = await ref.get();
  if (!snap.exists) throw clientError('Ticket not found.', 404);
  const notes = await ref.collection('internalNotes').orderBy('createdAt', 'asc').get();
  return { notes: notes.docs.map(n => ({ id: n.id, ...n.data() })) };
}

/**
 * Sign an image upload for support attachments (same signing logic as
 * media/sign-upload but IMAGES ONLY, max 5 MB, folder herstep/support/<uid>).
 */
export function buildSupportSignature({ crypto, cloudName, apiKey, apiSecret, uid, fileName, bytes }) {
  const extension = String(fileName || '').split('.').pop().toLowerCase();
  if (!['jpg', 'jpeg', 'png', 'webp'].includes(extension)) throw clientError('Only JPG, PNG or WEBP images can be attached.');
  if (!Number.isInteger(bytes) || bytes < 1) throw clientError('Upload request is invalid.');
  if (bytes > 5 * 1024 * 1024) throw clientError('Each image must be 5 MB or smaller.');
  const missing = [];
  if (!cloudName) missing.push('CLOUDINARY_CLOUD_NAME');
  if (!apiKey) missing.push('CLOUDINARY_API_KEY');
  if (!apiSecret) missing.push('CLOUDINARY_API_SECRET');
  if (missing.length) throw clientError(`Server configuration is missing ${missing.join(', ')}.`, 503);

  const folder = `herstep/support/${uid}`;
  const publicId = `${Date.now()}-${crypto.randomUUID()}`;
  const timestamp = Math.floor(Date.now() / 1000);
  const signature = crypto
    .createHash('sha1')
    .update(`folder=${folder}&public_id=${publicId}&timestamp=${timestamp}${apiSecret.trim()}`)
    .digest('hex');
  return {
    cloudName: cloudName.trim(),
    apiKey: apiKey.trim(),
    timestamp,
    signature,
    folder,
    publicId,
    resourceType: 'image',
    allowedFormats: ['jpg', 'jpeg', 'png', 'webp'],
    maxBytes: 5 * 1024 * 1024,
  };
}

function ts(value) {
  if (value && typeof value === 'object' && typeof value.toMillis === 'function') return value.toMillis();
  if (value && typeof value === 'object' && value.__serverTs) return Number(value.n) || 0;
  const parsed = Date.parse(String(value ?? ''));
  return Number.isFinite(parsed) ? parsed : 0;
}
