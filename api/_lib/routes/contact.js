// Thin HTTP wrapper for POST /api/contact (public, no login). All logic lives
// in contact-core.js so scripts/test-contact.mjs can exercise every branch.
import { waitUntil } from '@vercel/functions';
import { adminDb, requireUser } from '../firebase-admin.js';
import { methodNotAllowed } from '../http.js';
import { sendTelegramMessage } from '../telegram.js';
import { hashIp, submitContactMessage } from './contact-core.js';

export default async function contact(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
  // Optional uid when an Authorization token is present — anonymous visitors
  // must still be able to submit, so a missing or invalid token simply means
  // "anonymous" instead of blocking the public form.
  let uid = null;
  const token = String(req.headers?.authorization || '').match(/^Bearer\s+(.+)$/i)?.[1];
  if (token) {
    try {
      uid = (await requireUser(req)).uid;
    } catch { /* anonymous submission */ }
  }
  const forwarded = String(req.headers?.['x-forwarded-for'] || '').split(',')[0].trim();
  const result = await submitContactMessage({
    db: adminDb,
    body: req.body || {},
    ipHash: hashIp(forwarded || req.ip || 'unknown'),
    uid,
    sendTelegram: sendTelegramMessage,
    waitUntil,
  });
  return res.status(200).json(result.honeypot ? { ok: true } : { ok: true, messageId: result.messageId });
}
