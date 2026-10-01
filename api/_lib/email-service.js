// Email service (Brevo) with a transactional outbox.
//
// RULES (AGENTS.md Phase 2):
//   * Email is BEST-EFFORT: it must NEVER block or fail checkout, payments,
//     signup or support. Every caller wraps us in try/catch; we also never
//     throw from the delivery helpers.
//   * Emails are queued INSIDE the Firestore transaction that commits the
//     business change (queueEmail takes the tx), using DETERMINISTIC keys so
//     a retry can never double-send: emailOutbox/{emailId(key)} — an existing
//     doc means "already queued".
//   * Actual sending happens AFTER commit via deliverQueuedEmail /
//     deliverQueuedEmailInline + waitUntil.
//   * Missing configuration is NOT an error for the customer: we console.warn
//     ONCE per process and mark the admin status endpoint.
//
// All network calls go through `fetchImpl` so tests run offline.
import { FieldValue } from 'firebase-admin/firestore';

const BREVO_URL = 'https://api.brevo.com/v3/smtp/email';
const PURPOSES = ['hello', 'support', 'orders', 'payments', 'promotions'];

let warnedMissing = false;

export function emailConfig() {
  const env = (globalThis.process?.env || {});
  const apiKey = String(env.BREVO_API_KEY || '').trim();
  const senderName = String(env.BREVO_SENDER_NAME || 'HerStep Collection').trim();
  const replyTo = String(env.BREVO_REPLY_TO_EMAIL || '').trim();
  const senders = {};
  for (const purpose of PURPOSES) {
    senders[purpose] = String(env[`BREVO_SENDER_${purpose.toUpperCase()}`] || '').trim();
  }
  return { apiKey, senderName, replyTo, senders };
}

// Which purposes still have no sender address configured.
export function missingSenderPurposes(cfg = emailConfig()) {
  return PURPOSES.filter(p => !cfg.senders[p]);
}

export function emailConfigured(cfg = emailConfig()) {
  return Boolean(cfg.apiKey && missingSenderPurposes(cfg).length === 0);
}

// One console.warn per process when email is not configured — never spam logs,
// never surface anything to the customer.
function warnMissingOnce(cfg = emailConfig()) {
  if (warnedMissing) return;
  warnedMissing = true;
  const missing = [];
  if (!cfg.apiKey) missing.push('BREVO_API_KEY');
  for (const p of missingSenderPurposes(cfg)) missing.push(`BREVO_SENDER_${p.toUpperCase()}`);
  console.warn(`[email] skipped: not configured (${missing.join(', ')}). Set these environment variables in Vercel.`);
}

// Deterministic outbox id: replace everything outside [A-Za-z0-9_-] with _ and
// cut to 180 chars (Firestore id limit is 1500; 180 keeps docs readable).
export function emailId(key) {
  return String(key || '')
    .replace(/[^A-Za-z0-9_-]/g, '_')
    .slice(0, 180);
}

// Queue an email INSIDE a Firestore transaction. tx.set on a deterministic id
// is safe to replay: re-running the same event writes the same doc (the
// delivery pass only picks up PENDING ones).
export function queueEmail(tx, db, { key, purpose, to, subject, htmlContent }) {
  if (!key || !to || !subject || !htmlContent) {
    throw new Error('queueEmail requires key, purpose, to, subject and htmlContent.');
  }
  if (!PURPOSES.includes(purpose)) throw new Error(`Unknown email purpose "${purpose}".`);
  tx.set(db.collection('emailOutbox').doc(emailId(key)), {
    key: String(key),
    purpose,
    to: String(to).trim().toLowerCase(),
    subject: String(subject),
    htmlContent: String(htmlContent),
    status: 'PENDING',
    createdAt: FieldValue.serverTimestamp(),
    sentAt: null,
    lastError: null,
  });
}

// POST to Brevo. Throws on any failure — callers catch.
export async function sendEmail({ purpose, to, subject, htmlContent }, cfg = emailConfig(), fetchImpl = globalThis.fetch) {
  const senderEmail = cfg.senders[purpose];
  if (!cfg.apiKey || !senderEmail) {
    throw new Error(`Email not configured for purpose "${purpose}".`);
  }
  const body = {
    sender: { email: senderEmail, name: cfg.senderName },
    to: [{ email: to }],
    subject,
    htmlContent,
  };
  if (cfg.replyTo) body.replyTo = { email: cfg.replyTo };
  const response = await fetchImpl(BREVO_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': cfg.apiKey },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    let detail = '';
    try { detail = String((await response.text()).slice(0, 300)); } catch { /* ignore */ }
    throw new Error(`Brevo responded ${response.status}${detail ? `: ${detail}` : ''}`);
  }
  return true;
}

// Move one outbox doc PENDING -> SENDING (transaction, so two concurrent
// workers cannot both grab it), send, then SENT; on failure back to PENDING
// with lastError. NEVER throws into the caller.
export async function deliverQueuedEmail(db, docId, { cfg = emailConfig(), fetchImpl = globalThis.fetch } = {}) {
  try {
    const ref = db.collection('emailOutbox').doc(docId);
    const claimed = await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists) return null;
      const data = snap.data();
      if (data.status !== 'PENDING') return null; // already sent / in flight
      tx.update(ref, { status: 'SENDING' });
      return data;
    });
    if (!claimed) return { skipped: true };

    try {
      await sendEmail(
        { purpose: claimed.purpose, to: claimed.to, subject: claimed.subject, htmlContent: claimed.htmlContent },
        cfg,
        fetchImpl,
      );
      await ref.update({ status: 'SENT', sentAt: FieldValue.serverTimestamp(), lastError: null });
      return { sent: true };
    } catch (error) {
      // Back to PENDING so the next retry pass tries again. The caller of
      // deliverQueuedEmail never sees an exception.
      await ref.update({ status: 'PENDING', lastError: 'Delivery attempt failed.' }).catch(() => {});
      console.error(`[email] delivery failed for ${docId}:`, error?.message || error);
      return { sent: false, error: error?.message || String(error) };
    }
  } catch (error) {
    console.error('[email] deliverQueuedEmail unexpected failure:', error?.message || error);
    return { sent: false, error: error?.message || String(error) };
  }
}

// Convenience used right after a route commits its own transaction: queue was
// written inside the tx; now deliver it best-effort (fire-and-forget with
// waitUntil at the route layer). Missing config = skip quietly.
export async function deliverQueuedEmailInline(db, key, options = {}) {
  const cfg = options.cfg || emailConfig();
  if (!emailConfigured(cfg)) {
    warnMissingOnce(cfg);
    return { skipped: true, reason: 'not-configured' };
  }
  return deliverQueuedEmail(db, emailId(key), { ...options, cfg });
}

// Retry pass: deliver up to `limit` PENDING emails older than `olderThanMs`.
// Best effort — never throws. Used by GET /api/admin/orders and the manual
// "Retry pending emails" button.
export async function retryPendingEmails(db, { limit = 5, olderThanMs = 2 * 60_000, now = Date.now(), ...options } = {}) {
  try {
    const cfg = options.cfg || emailConfig();
    if (!emailConfigured(cfg)) {
      warnMissingOnce(cfg);
      return { attempted: 0, sent: 0, skipped: true, reason: 'not-configured' };
    }
    const snap = await db.collection('emailOutbox').where('status', '==', 'PENDING').limit(100).get();
    const rows = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(e => {
        const created = e.createdAt?.toMillis ? e.createdAt.toMillis() : Date.parse(String(e.createdAt || ''));
        return Number.isFinite(created) ? now - created > olderThanMs : true;
      })
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))
      .slice(0, limit);
    let sent = 0;
    for (const e of rows) {
      const result = await deliverQueuedEmail(db, e.id, { ...options, cfg });
      if (result.sent) sent += 1;
    }
    return { attempted: rows.length, sent };
  } catch (error) {
    console.error('[email] retryPendingEmails failed:', error?.message || error);
    return { attempted: 0, sent: 0, error: true };
  }
}
