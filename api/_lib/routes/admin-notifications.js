// Notification admin routes (registered in api/admin.js as ?route=notifications):
//   GET   /api/admin/notifications          — settings/email + settings/telegram
//           status, outbox stats, recent emailOutbox rows.
//   POST  /api/admin/notifications/test     — body {channel:'email'|'telegram', to?}.
//           Sends a real test through the SAME best-effort services and reports
//           exactly what happened; configuration problems come back as
//           { sent:false, reason:'not-configured', missing:[...] } instead of
//           breaking anything.
import { waitUntil } from '@vercel/functions';
import { adminDb, requireAdmin } from '../firebase-admin.js';
import { clientError, methodNotAllowed } from '../http.js';
import {
  emailConfig,
  missingSenderPurposes,
  deliverQueuedEmailInline,
  retryPendingEmails,
  emailId,
  queueEmail,
} from '../email-service.js';
import { emailHtml } from '../email-templates.js';
import { telegramConfig, sendTelegramMessage } from '../telegram.js';

const iso = v => (v?.toDate ? v.toDate().toISOString() : v || null);

export async function notificationStatus(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
  await requireAdmin(req);

  const cfg = emailConfig();
  const tg = telegramConfig();
  const missing = [];
  if (!cfg.apiKey) missing.push('BREVO_API_KEY');
  for (const p of missingSenderPurposes(cfg)) missing.push(`BREVO_SENDER_${p.toUpperCase()}`);
  if (!cfg.senderName) missing.push('BREVO_SENDER_NAME');
  if (!cfg.replyTo) missing.push('BREVO_REPLY_TO_EMAIL');

  // Outbox stats: single-field equality queries only (no composite indexes).
  const stats = { pending: 0, sending: 0, sent: 0 };
  let recent = [];
  try {
    const [pending, sending, sent] = await Promise.all([
      adminDb.collection('emailOutbox').where('status', '==', 'PENDING').limit(100).get(),
      adminDb.collection('emailOutbox').where('status', '==', 'SENDING').limit(100).get(),
      adminDb.collection('emailOutbox').where('status', '==', 'SENT').limit(50).get(),
    ]);
    stats.pending = pending.size;
    stats.sending = sending.size;
    stats.sent = sent.size;
    const all = [...pending.docs, ...sending.docs, ...sent.docs]
      .map(d => ({ id: d.id, ...d.data() }))
      .sort((a, b) => String(b.createdAt?.toDate?.()?.toISOString?.() ?? b.createdAt ?? '').localeCompare(String(a.createdAt?.toDate?.()?.toISOString?.() ?? a.createdAt ?? '')));
    recent = all.slice(0, 20).map(e => ({
      id: e.id,
      purpose: e.purpose ?? null,
      to: e.to ?? null,
      subject: e.subject ?? null,
      status: e.status ?? null,
      lastError: e.lastError ?? null,
      createdAt: iso(e.createdAt),
      sentAt: iso(e.sentAt),
    }));
  } catch (error) {
    console.error('[admin/notifications] outbox stats failed:', error?.message || error);
  }

  return res.json({
    email: {
      configured: Boolean(cfg.apiKey && missingSenderPurposes(cfg).length === 0),
      senderName: cfg.senderName || null,
      replyTo: cfg.replyTo || null,
      senders: cfg.senders,
      missing,
    },
    telegram: {
      configured: Boolean(tg.token && tg.chatId),
      missing: [!tg.token && 'TELEGRAM_BOT_TOKEN', !tg.chatId && 'TELEGRAM_CHAT_ID'].filter(Boolean),
    },
    outbox: { ...stats, recent },
  });
}

export async function notificationTest(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
  const admin = await requireAdmin(req);
  const channel = req.body?.channel;
  if (channel !== 'email' && channel !== 'telegram') throw clientError("channel must be 'email' or 'telegram'.");

  if (channel === 'telegram') {
    const tg = telegramConfig();
    if (!tg.token || !tg.chatId) {
      return res.json({ sent: false, reason: 'not-configured', missing: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'].filter(m => !(globalThis.process.env[m] || '').trim()) });
    }
    const ok = await sendTelegramMessage(`✅ Test message from HerStep admin (requested by ${admin.email || admin.uid}). Telegram notifications work.`);
    return res.json({ sent: ok, reason: ok ? null : 'send-failed' });
  }

  const cfg = emailConfig();
  if (!cfg.apiKey || missingSenderPurposes(cfg).length > 0) {
    const missing = [];
    if (!cfg.apiKey) missing.push('BREVO_API_KEY');
    for (const p of missingSenderPurposes(cfg)) missing.push(`BREVO_SENDER_${p.toUpperCase()}`);
    return res.json({ sent: false, reason: 'not-configured', missing });
  }
  const to = typeof req.body?.to === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(req.body.to.trim())
    ? req.body.to.trim().toLowerCase()
    : (admin.email || '');
  if (!to) throw clientError('Provide a "to" email address.');

  // Queue + deliver through the REAL outbox path so the test exercises the
  // exact same code as production events. Deterministic key per request time.
  const key = `TEST-${Date.now()}-${admin.uid}`;
  await adminDb.runTransaction(async tx => {
    const { subject, htmlContent } = emailHtml(
      'HerStep notifications test',
      'Hi,\n\nthis is a test email from the HerStep admin panel. If you can read this, Brevo transactional email is working end to end.',
    );
    queueEmail(tx, adminDb, { key, purpose: 'hello', to, subject, htmlContent });
  });
  const result = await deliverQueuedEmailInline(adminDb, key);
  if (result.sent) {
    return res.json({ sent: true, to });
  }
  let detail = result.error || null;
  if (!detail && !result.skipped) {
    const doc = await adminDb.collection('emailOutbox').doc(emailId(key)).get().catch(() => null);
    detail = doc?.data?.lastError || null;
  }
  return res.json({
    sent: false,
    reason: result.skipped ? 'not-configured' : 'send-failed',
    detail,
  });
}

// POST /api/admin/notifications/retry — body {limit?} (1..20, default 5).
// Delivers up to `limit` PENDING emails older than 2 minutes through the same
// claim-and-send path as production. Returns immediately; the actual sending
// continues via waitUntil so a slow Brevo never turns this button into a 504.
export async function notificationRetry(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
  await requireAdmin(req);
  const rawLimit = Number(req.body?.limit ?? 5);
  const limit = Number.isFinite(rawLimit) ? Math.min(20, Math.max(1, Math.trunc(rawLimit))) : 5;
  const pendingSnap = await adminDb.collection('emailOutbox').where('status', '==', 'PENDING').limit(100).get();
  const pending = pendingSnap.size;
  waitUntil(retryPendingEmails(adminDb, { limit }));
  return res.json({ ok: true, pendingBefore: pending, attemptedUpTo: limit });
}
