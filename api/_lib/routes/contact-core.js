// Contact form core — pure-ish functions over an injected db so
// scripts/test-contact.mjs can run EVERY branch against the strict fake
// Firestore (same pattern as email-verify-core.js / sync-profile-core.js).
//
// Data contract (AGENTS.md): contactMessages/{id} = { messageId 'MSG-000001'
// (counters/contactMessages.sequence, same transaction), name (2..80), email,
// phone (optional, normalised when given), message (5..2000), status
// NEW|READ|REPLIED|ARCHIVED, customerId (uid or null), ipHash, createdAt,
// updatedAt, repliedAt, lastReply }. The RAW client IP is never stored — only
// an HMAC hash of it, used for rate limiting and nothing else.
import crypto from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { clientError } from '../http.js';
import { normalizeKenyanPhone } from '../phone.js';
import { queueEmail, deliverQueuedEmailInline } from '../email-service.js';
import { contactReceivedEmail, contactReplyEmail } from '../email-templates.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
// Rate limits per hashed IP: 3 per rolling hour, 10 per rolling day.
const HOUR_LIMIT = 3;
const DAY_LIMIT = 10;
// Status flow: NEW -> READ -> REPLIED -> ARCHIVED. Any move that does not go
// BACKWARDS in this list is allowed; ARCHIVED is final. REPLIED is also set by
// the reply route itself.
const STATUS_ORDER = ['NEW', 'READ', 'REPLIED', 'ARCHIVED'];

// Deterministic reference id shown to the customer ("MSG-000001").
export function formatMessageId(sequence) {
  return `MSG-${String(sequence).padStart(6, '0')}`;
}

// One-way hash of the client IP. Keyed with the Firebase project id so the
// values are useless outside this app and cannot be reversed by brute force
// (Kenyan IPv4 space is small enough to precompute without a secret key).
export function hashIp(ip, projectId = process.env.FIREBASE_ADMIN_PROJECT_ID || 'herstep') {
  return crypto.createHmac('sha256', `contact-ip:${projectId}`).update(String(ip || '')).digest('hex').slice(0, 32);
}

function clientIp(req) {
  const forwarded = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  return forwarded || String(req.ip || req.socket?.remoteAddress || 'unknown');
}

// Validate + trim the public POST body. Unknown fields are rejected so nobody
// can smuggle extra keys into the document. Returns { honeypot } when the bot
// field is filled — the caller answers 200 and stores NOTHING.
export function parseContactInput(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw clientError('Invalid request body.');
  const allowed = ['name', 'email', 'phone', 'message', 'website'];
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) throw clientError('Unknown contact field.');
  }
  // Honeypot: real users never fill the visually-hidden "website" input.
  if (String(body.website ?? '').trim() !== '') return { honeypot: true };

  const name = String(body.name ?? '').trim().replace(/\s+/g, ' ');
  const email = String(body.email ?? '').trim().toLowerCase();
  const rawPhone = String(body.phone ?? '').trim();
  const message = String(body.message ?? '').trim();

  if (name.length < 2 || name.length > 80) throw clientError('Name must be 2 to 80 characters.');
  if (!EMAIL_RE.test(email) || email.length > 160) throw clientError('Enter a valid email address.');
  const phone = rawPhone ? normalizeKenyanPhone(rawPhone) : null;
  if (message.length < 5 || message.length > 2000) throw clientError('Message must be 5 to 2000 characters.');

  return { honeypot: false, name, email, phone, message };
}

// Rate-limit check + reservation on rateLimits/contact_<ipHash>. Runs INSIDE
// the save transaction so two concurrent submissions cannot both pass.
// Window model: hourWindowStart/hourCount reset after HOUR_MS; dayWindowStart/
// dayCount reset after DAY_MS. Throws 429 when either limit is reached.
// The caller must tx.get() the doc FIRST and pass the snapshot in — Firestore
// transactions reject any read issued after a write ("all reads before all
// writes"), which used to make EVERY real submission die with an untyped error
// that surfaced as a 500 "We could not complete that request."
function reserveRateSlot(tx, ref, snap, ipHash, nowMs) {
  const data = snap.exists ? snap.data() : {};
  const hourStart = Number(data.hourWindowStart) || 0;
  const dayStart = Number(data.dayWindowStart) || 0;
  const hourCount = nowMs - hourStart < HOUR_MS ? Number(data.hourCount) || 0 : 0;
  const dayCount = nowMs - dayStart < DAY_MS ? Number(data.dayCount) || 0 : 0;
  const effectiveHour = nowMs - hourStart < HOUR_MS ? hourStart : nowMs;
  const effectiveDay = nowMs - dayStart < DAY_MS ? dayStart : nowMs;
  if (hourCount >= HOUR_LIMIT || dayCount >= DAY_LIMIT) {
    const waitMs = hourCount >= HOUR_LIMIT ? Math.max(0, HOUR_MS - (nowMs - effectiveHour)) : Math.max(0, DAY_MS - (nowMs - effectiveDay));
    const error = clientError(`Too many messages from this connection. Please try again in ${Math.max(1, Math.ceil(waitMs / 60_000))} minute(s).`, 429);
    error.retryAfterSeconds = Math.max(1, Math.ceil(waitMs / 1000));
    throw error;
  }
  tx.set(ref, {
    hourWindowStart: effectiveHour,
    hourCount: hourCount + 1,
    dayWindowStart: effectiveDay,
    dayCount: dayCount + 1,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });
}

// POST /api/contact — public. Saves the message + counter + rate slot in ONE
// transaction, then queues the auto-reply inside the same transaction. After
// the commit the caller delivers the email best-effort (waitUntil). Telegram
// and email failures NEVER fail the request.
export async function submitContactMessage({ db, body, ipHash, uid, now = Date.now(), telegramText = null, sendTelegram = null, waitUntil = null }) {
  const input = parseContactInput(body);
  if (input.honeypot) {
    // Pretend success; store nothing, send nothing.
    return { ok: true, honeypot: true };
  }
  // The Telegram alert is built by the core itself when the caller supplies
  // only `sendTelegram` — previously contact.js never passed `telegramText`,
  // so admins silently received NO alerts in production.
  const wantTelegram = Boolean(sendTelegram) && telegramText !== false;

  const result = await db.runTransaction(async tx => {
    // READS FIRST (Firestore rule: no read may follow a write inside a tx):
    // rate-limit doc, then the counter. Only then we write.
    const rateRef = db.collection('rateLimits').doc(`contact_${ipHash}`);
    const rateSnap = await tx.get(rateRef);
    const counter = db.collection('counters').doc('contactMessages');
    const counterSnap = await tx.get(counter);

    reserveRateSlot(tx, rateRef, rateSnap, ipHash, now);

    const sequence = Number(counterSnap.exists ? counterSnap.data().sequence : 0) + 1;
    const messageId = formatMessageId(sequence);
    const ref = db.collection('contactMessages').doc();
    tx.set(counter, { sequence }, { merge: true });
    tx.set(ref, {
      messageId,
      name: input.name,
      email: input.email,
      phone: input.phone,
      message: input.message,
      status: 'NEW',
      customerId: uid || null,
      ipHash,
      repliedAt: null,
      lastReply: null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    // Auto-reply queued in the SAME transaction (deterministic key => a
    // replayed submit can never double-send; and a honeypot/rate reject never
    // reaches here at all).
    const emailKey = `${ref.id}-CONTACT-RECEIVED`;
    const email = contactReceivedEmail({ name: input.name, messageId });
    queueEmail(tx, db, { key: emailKey, purpose: 'support', to: input.email, subject: email.subject, htmlContent: email.htmlContent });
    return { id: ref.id, messageId, emailKey };
  });

  // Best-effort side effects AFTER commit — never propagate failures.
  if (wantTelegram) {
    const text = typeof telegramText === 'string' && telegramText
      ? telegramText
      : `New contact message ${result.messageId} from ${input.name} (${input.phone || input.email}): ${input.message.slice(0, 120)}`;
    try {
      const p = Promise.resolve(sendTelegram(text)).catch(() => false);
      if (waitUntil) waitUntil(p); else await p;
    } catch { /* ignore */ }
  }
  const deliver = async () => {
    try { await deliverQueuedEmailInline(db, result.emailKey); } catch { /* email failure never fails the request */ }
  };
  if (waitUntil) waitUntil(deliver()); else await deliver();

  return { ok: true, messageId: result.messageId, id: result.id };
}

// GET /api/admin/contact-messages?status=&cursor= — newest first (client-side
// sort on createdAt; keeps AGENTS.md's "no composite index dependency" rule),
// bounded page, cursor = last displayed doc id. Includes the unread count.
export async function listContactMessages({ db, status, cursor, limit = 100 }) {
  if (status && !STATUS_ORDER.includes(status)) throw clientError('Unknown message status.');
  const snap = await db.collection('contactMessages').limit(500).get();
  const all = snap.docs.map(doc => ({ id: doc.id, rawCreatedAt: doc.data().createdAt, ...normalizeContactDoc(doc) }));
  // Sort key must work for REAL Firestore Timestamps too (they have no
  // localeCompare on the object — without toDate() every row got '' and the
  // "newest first" order silently became document-ID order).
  const ts = v => {
    if (!v) return 0;
    // fake-firestore serverTimestamp sentinel: monotonically increasing `n`
    // (mirrors real Firestore ordering server timestamps by write time).
    if (v.__serverTs) return Number(v.n) || 0;
    if (typeof v === 'number') return v;
    if (v.toDate) { try { return v.toDate().getTime(); } catch { return 0; } }
    if (v.seconds != null) return Number(v.seconds) * 1000;
    const parsed = Date.parse(String(v));
    return Number.isNaN(parsed) ? 0 : parsed;
  };
  const rows = all
    .filter(row => !status || row.status === status)
    .sort((a, b) => ts(b.rawCreatedAt) - ts(a.rawCreatedAt));
  const unreadTotal = all.filter(r => r.status === 'NEW').length;
  let page = rows;
  if (cursor) {
    const index = rows.findIndex(row => row.id === cursor);
    page = index >= 0 ? rows.slice(index + 1) : rows;
  }
  page = page.slice(0, limit);
  return {
    messages: page,
    nextCursor: page.length === limit ? page[page.length - 1].id : null,
    unread: unreadTotal,
  };
}

function normalizeContactDoc(doc) {
  const iso = value => (value?.toDate ? value.toDate().toISOString() : value || null);
  const data = doc.data ? doc.data() : doc;
  return { ...data, createdAt: iso(data.createdAt), updatedAt: iso(data.updatedAt), repliedAt: iso(data.repliedAt) };
}

// PATCH /api/admin/contact-messages { id, status } — NEW->READ->REPLIED->
// ARCHIVED; any non-final forward move is allowed, backwards moves are not.
export async function updateContactStatus({ db, admin, id, status }) {
  if (!id || typeof id !== 'string') throw clientError('Message id is required.');
  if (!STATUS_ORDER.includes(status)) throw clientError('Unknown message status.');
  const ref = db.collection('contactMessages').doc(id);
  const updated = await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw clientError('Message not found.', 404);
    const current = String(snap.data().status || 'NEW');
    const from = STATUS_ORDER.indexOf(current);
    const to = STATUS_ORDER.indexOf(status);
    if (current === 'ARCHIVED') throw clientError('Archived messages cannot change status.', 409);
    if (to < from) throw clientError('This message status cannot be changed that way.', 409);
    if (to !== from) tx.update(ref, { status, updatedAt: FieldValue.serverTimestamp() });
    return current;
  });
  await db.collection('auditLogs').add({
    adminId: admin.uid,
    adminName: admin.displayName || admin.email || '',
    action: 'CONTACT_STATUS',
    targetType: 'contactMessage',
    targetId: id,
    previous: updated,
    next: status,
    createdAt: FieldValue.serverTimestamp(),
  });
  return { ok: true };
}

// POST /api/admin/contact-messages/reply { id, body } — sends the support
// email, stores lastReply/repliedAt, sets REPLIED, writes auditLogs
// (CONTACT_REPLIED). Email delivery happens after commit; even if sending
// fails the internal state still records the reply attempt outcome.
export async function replyContactMessage({ db, admin, id, body, waitUntil = null }) {
  if (!id || typeof id !== 'string') throw clientError('Message id is required.');
  const text = String(body ?? '').trim();
  if (!text || text.length > 3000) throw clientError('Reply must be 1 to 3000 characters.');
  const result = await db.runTransaction(async tx => {
    const ref = db.collection('contactMessages').doc(id);
    const snap = await tx.get(ref);
    if (!snap.exists) throw clientError('Message not found.', 404);
    const message = snap.data();
    if (String(message.status) === 'ARCHIVED') throw clientError('Archived messages cannot be replied to.', 409);
    const email = contactReplyEmail({
      name: message.name,
      body: text,
      originalMessage: message.message,
      messageId: message.messageId,
    });
    const emailKey = `${id}-CONTACT-REPLY-${Date.now()}`;
    queueEmail(tx, db, { key: emailKey, purpose: 'support', to: message.email, subject: email.subject, htmlContent: email.htmlContent });
    tx.update(ref, {
      status: 'REPLIED',
      lastReply: text,
      repliedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    tx.set(db.collection('auditLogs').doc(), {
      adminId: admin.uid,
      adminName: admin.displayName || admin.email || '',
      action: 'CONTACT_REPLIED',
      targetType: 'contactMessage',
      targetId: id,
      previous: message.status || 'NEW',
      next: 'REPLIED',
      createdAt: FieldValue.serverTimestamp(),
    });
    return { emailKey, to: message.email };
  });

  // Deliver right after commit (best effort — a Brevo outage must not 500 the
  // admin panel; the outbox retry pass will pick the PENDING doc up later).
  const deliver = async () => {
    try { return await deliverQueuedEmailInline(db, result.emailKey); } catch { return { sent: false }; }
  };
  if (waitUntil) {
    waitUntil(deliver());
    return { ok: true, sent: null };
  }
  const delivered = await deliver();
  return { ok: true, sent: Boolean(delivered?.sent), skipped: Boolean(delivered?.skipped) };
}
