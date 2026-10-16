import crypto from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { FieldValue } from 'firebase-admin/firestore';
import { adminDb, requireAdmin } from '../firebase-admin.js';
import { clientError, methodNotAllowed } from '../http.js';
import { deliverQueuedSms, smsConfig, smsId } from '../sms-service.js';
import { siteUrl } from '../site-url.js';

const MAX_RECIPIENTS = 100;
const MAX_MESSAGE_LENGTH = 1800;

function normalizePhone(value) {
  let digits = String(value || '').trim().replace(/\D/g, '');
  if (/^0[17]\d{8}$/.test(digits)) digits = '254' + digits.slice(1);
  else if (/^[17]\d{8}$/.test(digits)) digits = '254' + digits;
  return /^254[17]\d{8}$/.test(digits) ? '+' + digits : '';
}

function optOutToken(uid) {
  const secret = String(process.env.FIREBASE_ADMIN_PRIVATE_KEY || '').trim();
  if (!secret) throw new Error('Firebase admin key is not configured.');
  return crypto.createHmac('sha256', secret).update(String(uid)).digest('hex');
}

function optOutUrl(uid) {
  return `${siteUrl()}/api/marketing/sms-unsubscribe?uid=${encodeURIComponent(uid)}&token=${encodeURIComponent(optOutToken(uid))}`;
}

function campaignMessage(message, recipient) {
  const body = String(message || '').trim();
  if (!body || body.length > MAX_MESSAGE_LENGTH) {
    throw clientError(`SMS message must be between 1 and ${MAX_MESSAGE_LENGTH} characters.`);
  }
  return recipient.test ? `[TEST] ${body}` : `${body}\nOpt out: ${optOutUrl(recipient.uid)}`;
}

function iso(value) {
  return value?.toDate ? value.toDate().toISOString() : value || null;
}

async function queueAndDeliver({ key, to, message, campaignId = null }) {
  const id = smsId(key);
  const ref = adminDb.collection('smsOutbox').doc(id);
  await ref.set({
    key,
    to,
    message,
    status: 'PENDING',
    providerMessageId: null,
    lastError: null,
    campaignId,
    createdAt: FieldValue.serverTimestamp(),
    sentAt: null,
    updatedAt: FieldValue.serverTimestamp(),
  });
  return deliverQueuedSms(adminDb, key);
}

export async function adminSmsCampaigns(req, res) {
  await requireAdmin(req);
  if (req.method === 'GET') {
    const [campaignSnap, userSnap] = await Promise.all([
      adminDb.collection('smsCampaigns').orderBy('createdAt', 'desc').limit(20).get(),
      adminDb.collection('users').where('smsMarketingConsent', '==', true).get(),
    ]);
    const eligible = userSnap.docs.filter(doc => normalizePhone(doc.data().phoneNumber)).length;
    const campaigns = campaignSnap.docs.map(doc => {
      const row = doc.data();
      return {
        id: doc.id, name: row.name || 'SMS campaign', message: row.message || '',
        status: row.status || 'UNKNOWN', recipients: Number(row.recipients) || 0,
        sent: Number(row.sent) || 0, failed: Number(row.failed) || 0, createdAt: iso(row.createdAt),
      };
    });
    return res.status(200).json({ campaigns, eligibleRecipients: eligible, maxRecipients: MAX_RECIPIENTS, maxMessageLength: MAX_MESSAGE_LENGTH });
  }
  if (req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);

  const admin = await requireAdmin(req);
  const cfg = smsConfig();
  if (!cfg.apiKey) return res.status(503).json({ sent: false, reason: 'not-configured', detail: 'HashBack SMS is not configured. Set HASH_API_KEY in Vercel.' });
  const message = String(req.body?.message || '').trim();
  if (!message || message.length > MAX_MESSAGE_LENGTH) throw clientError(`SMS message must be between 1 and ${MAX_MESSAGE_LENGTH} characters.`);

  if (req.body?.mode === 'test') {
    const to = normalizePhone(req.body?.testPhone);
    if (!to) throw clientError('Enter a valid Kenyan test phone number (07…, 01…, 254… or +254…).');
    const key = `SMS-CAMPAIGN-TEST-${crypto.randomUUID()}`;
    const result = await queueAndDeliver({ key, to, message: campaignMessage(message, { test: true }) });
    if (!result.sent) return res.status(502).json({ sent: false, detail: 'HashBack could not send the test SMS. Check the SMS outbox and HashBack credentials.' });
    return res.status(200).json({ sent: true, to });
  }

  if (req.body?.mode !== 'send') throw clientError("mode must be 'test' or 'send'.");
  const usersSnap = await adminDb.collection('users').where('smsMarketingConsent', '==', true).get();
  const recipients = usersSnap.docs
    .map(doc => ({ uid: doc.id, to: normalizePhone(doc.data().phoneNumber) }))
    .filter(recipient => recipient.to);
  if (!recipients.length) throw clientError('There are no customers with a valid phone number who opted in to promotional SMS.');
  if (recipients.length > MAX_RECIPIENTS) {
    throw clientError(`This campaign has ${recipients.length} eligible recipients. The safe limit per campaign is ${MAX_RECIPIENTS}; split the audience before sending.`, 413);
  }

  const campaignId = crypto.randomUUID();
  const campaignRef = adminDb.collection('smsCampaigns').doc(campaignId);
  const batch = adminDb.batch();
  for (const recipient of recipients) {
    const key = `SMS-CAMPAIGN-${campaignId}-${recipient.uid}`;
    batch.set(adminDb.collection('smsOutbox').doc(smsId(key)), {
      key, to: recipient.to, message: campaignMessage(message, recipient),
      status: 'PENDING', providerMessageId: null, lastError: null, campaignId,
      createdAt: FieldValue.serverTimestamp(), sentAt: null, updatedAt: FieldValue.serverTimestamp(),
    });
  }
  await batch.commit();
  await campaignRef.set({
    name: String(req.body?.name || '').trim().slice(0, 100) || 'SMS campaign',
    message, status: 'QUEUED', recipients: recipients.length, sent: 0, failed: 0,
    createdBy: admin.uid, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
  });

  waitUntil((async () => {
    let sent = 0;
    let failed = 0;
    for (let i = 0; i < recipients.length; i += 5) {
      const chunk = recipients.slice(i, i + 5);
      const results = await Promise.all(chunk.map(recipient =>
        deliverQueuedSms(adminDb, `SMS-CAMPAIGN-${campaignId}-${recipient.uid}`),
      ));
      for (const result of results) result.sent ? sent++ : failed++;
      await campaignRef.update({
        sent, failed,
        status: sent + failed >= recipients.length ? (failed ? (sent ? 'PARTIAL' : 'FAILED') : 'SENT') : 'SENDING',
        updatedAt: FieldValue.serverTimestamp(),
      }).catch(() => {});
    }
  })().catch(async error => {
    console.error('[admin/sms-campaigns] delivery worker failed:', error?.message || error);
    await campaignRef.update({ status: 'PARTIAL', updatedAt: FieldValue.serverTimestamp() }).catch(() => {});
  }));

  return res.status(202).json({ queued: true, campaignId, recipients: recipients.length });
}

export async function smsMarketingUnsubscribe(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
  const uid = String(req.query?.uid || '').trim();
  const token = String(req.query?.token || '').trim();
  if (!uid || !token || uid.length > 128) return res.status(400).send('This opt-out link is invalid.');
  let expected;
  try { expected = optOutToken(uid); } catch { return res.status(503).send('SMS opt-out is temporarily unavailable. Please update your preferences in your HerStep account.'); }
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(400).send('This opt-out link is invalid.');
  const userRef = adminDb.collection('users').doc(uid);
  const user = await userRef.get();
  if (!user.exists) return res.status(404).send('This account could not be found.');
  await userRef.update({ smsMarketingConsent: false, updatedAt: FieldValue.serverTimestamp() });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="font-family:Arial,sans-serif;max-width:560px;margin:48px auto;padding:20px;color:#171717"><h1>SMS marketing stopped</h1><p>You have opted out of promotional SMS from HerStep Collection. Essential order, payment and account messages may still be sent.</p><p><a href="https://www.herstepcollection.shop">Return to HerStep Collection</a></p></body></html>');
}
