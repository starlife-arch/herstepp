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
// 'verify' carries the 6-digit email-verification codes (POST /api/auth/verify/send).
// It has NO fallback sender: when BREVO_SENDER_VERIFY is empty, missingSenderPurposes()
// lists it and /verify/send answers 503 ("Verification emails are not configured yet.").
// 'tips' sends the tip thank-you email. It falls back to the payments sender when
// BREVO_SENDER_TIPS is empty (optional purpose — never blocks anything).
// 'invoices' sends the invoice-style payment email. BREVO_SENDER_INVOICES is
// optional too: it falls back to the payments sender when empty.
const PURPOSES = ['hello', 'support', 'orders', 'payments', 'promotions', 'verify', 'tips', 'invoices'];

// Purposes that fall back to BREVO_SENDER_PAYMENTS when their own sender env is empty.
const PAYMENTS_FALLBACK_PURPOSES = new Set(['tips', 'invoices']);

let warnedMissing = false;

export function emailConfig() {
  const env = (globalThis.process?.env || {});
  const apiKey = String(env.BREVO_API_KEY || '').trim();
  const senderName = String(env.BREVO_SENDER_NAME || 'HerStep Collection').trim();
  const replyTo = String(env.BREVO_REPLY_TO_EMAIL || '').trim();
  const senders = {};
  for (const purpose of PURPOSES) {
    let sender = String(env[`BREVO_SENDER_${purpose.toUpperCase()}`] || '').trim();
    // Optional purposes (e.g. 'tips') fall back to the payments sender when their
    // own BREVO_SENDER_* env is empty. 'verify' deliberately never falls back.
    if (!sender && PAYMENTS_FALLBACK_PURPOSES.has(purpose)) {
      sender = String(env.BREVO_SENDER_PAYMENTS || '').trim();
    }
    senders[purpose] = sender;
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
// attachInvoiceFor: order document id whose invoice PDF must be generated AT
// SEND TIME and attached. The PDF bytes are NEVER stored in this outbox doc
// (Firestore ~1 MiB document limit) — regeneration also makes retries work.
export function queueEmail(tx, db, { key, purpose, to, subject, htmlContent, attachInvoiceFor = null }) {
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
    attachInvoiceFor: attachInvoiceFor ? String(attachInvoiceFor) : null,
    createdAt: FieldValue.serverTimestamp(),
    sentAt: null,
    lastError: null,
  });
}

// POST to Brevo. Throws on any failure — callers catch.
// attachments: [{ name, content: <base64 string> }] (Brevo v3 smtp/email shape).
export async function sendEmail({ purpose, to, subject, htmlContent, attachments }, cfg = emailConfig(), fetchImpl = globalThis.fetch) {
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
  if (Array.isArray(attachments) && attachments.length) body.attachment = attachments;
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

// Default invoice source loader used by deliverQueuedEmail when the caller did
// not inject one: order + its PAID payment, straight from Firestore. Kept here
// (not in invoice-pdf.js) so the PDF builder stays a pure function.
async function loadInvoiceSource(db, orderDocumentId) {
  const orderSnap = await db.collection('orders').doc(orderDocumentId).get();
  if (!orderSnap.exists) return null;
  const order = orderSnap.data();
  let payment = null;
  const payRef = order.paymentId ? db.collection('payments').doc(order.paymentId) : null;
  if (payRef) {
    const paySnap = await payRef.get();
    if (paySnap.exists) payment = { id: paySnap.id, ...paySnap.data() };
  }
  if (!payment) {
    const q = await db.collection('payments').where('orderDocumentId', '==', orderDocumentId).limit(1).get();
    if (!q.empty) payment = { id: q.docs[0].id, ...q.docs[0].data() };
  }
  return { order: { id: orderDocumentId, ...order }, payment };
}

// Move one outbox doc PENDING -> SENDING (transaction, so two concurrent
// workers cannot both grab it), send, then SENT; on failure back to PENDING
// with lastError. NEVER throws into the caller.
// options.invoiceLoader(orderDocId) -> { order, payment } | null (default:
// reads from db). The invoice PDF is generated HERE, at send time — never
// stored in the outbox document (size limit). If generation fails the email
// still sends WITHOUT the attachment and the error is logged; a PDF problem
// must never fail delivery or the payment flow.
export async function deliverQueuedEmail(db, docId, { cfg = emailConfig(), fetchImpl = globalThis.fetch, invoiceLoader = null, buildPdf = null } = {}) {
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

    let attachments = null;
    if (claimed.attachInvoiceFor) {
      try {
        const loaded = invoiceLoader
          ? await invoiceLoader(claimed.attachInvoiceFor)
          : await loadInvoiceSource(db, claimed.attachInvoiceFor);
        if (loaded?.order) {
          const build = buildPdf || (await import('./invoice-pdf.js')).buildInvoicePdf;
          const pdfBytes = await build(loaded);
          const invNo = loaded.order.invoiceNumber || '';
          attachments = [{ name: `HerStep-Invoice-${invNo}.pdf`, content: Buffer.from(pdfBytes).toString('base64') }];
        }
      } catch (error) {
        console.error(`[email] invoice PDF generation failed for ${claimed.attachInvoiceFor}:`, error?.message || error);
        attachments = null; // send without the attachment — never block the email
      }
    }

    try {
      await sendEmail(
        { purpose: claimed.purpose, to: claimed.to, subject: claimed.subject, htmlContent: claimed.htmlContent, attachments },
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
  // The 'verify' purpose has NO fallback sender: when BREVO_SENDER_VERIFY is
  // missing, emailConfigured() is false and this stays quiet (the /verify/send
  // route itself answers 503 before anything is queued — see
  // api/_lib/routes/email-verify-core.js).
  if (!emailConfigured(cfg)) {
    warnMissingOnce(cfg);
    return { skipped: true, reason: 'not-configured' };
  }
  return deliverQueuedEmail(db, emailId(key), { ...options, cfg });
}

// True only when the 'verify' purpose can actually send: API key + a dedicated
// BREVO_SENDER_VERIFY address. There is deliberately no fallback to another
// sender for verification codes.
export function verifySenderConfigured(cfg = emailConfig()) {
  return Boolean(cfg.apiKey && cfg.senders.verify);
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
