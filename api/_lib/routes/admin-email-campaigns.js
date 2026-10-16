import crypto from 'node:crypto';
import { waitUntil } from '@vercel/functions';
import { FieldValue } from 'firebase-admin/firestore';
import { adminDb, requireAdmin } from '../firebase-admin.js';
import { clientError, methodNotAllowed } from '../http.js';
import { emailConfig, sendEmail, deliverQueuedEmail, emailId } from '../email-service.js';
import { siteUrl } from '../site-url.js';

const MAX_RECIPIENTS = 100;
const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function safeHttpsUrl(value, label, optional = false) {
  const raw = String(value ?? '').trim();
  if (!raw && optional) return '';
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw clientError(`${label} must be a complete https:// URL.`);
  }
  if (url.protocol !== 'https:') throw clientError(`${label} must use https://.`);
  return url.toString();
}

function validateCampaign(body = {}) {
  const format = body.format === 'text' ? 'text' : 'html';
  const subject = String(body.subject ?? '').trim();
  const headline = String(body.headline ?? '').trim();
  const message = String(body.message ?? '').trim();
  const imageUrl = safeHttpsUrl(body.imageUrl, 'Image URL', true);
  const buttonLabel = String(body.buttonLabel ?? '').trim();
  const rawButtonUrl = String(body.buttonUrl ?? '').trim();
  const buttonUrl = rawButtonUrl
    ? (rawButtonUrl.startsWith('/') ? `${siteUrl()}${rawButtonUrl}` : safeHttpsUrl(rawButtonUrl, 'Button link'))
    : '';
  if (subject.length < 3 || subject.length > 140) throw clientError('Subject must be 3–140 characters.');
  if (headline.length < 2 || headline.length > 160) throw clientError('Headline must be 2–160 characters.');
  if (message.length < 5 || message.length > 4000) throw clientError('Message must be 5–4,000 characters.');
  if (imageUrl && !/^https:\/\//i.test(imageUrl)) throw clientError('Image URL must use https://.');
  if (buttonLabel && buttonLabel.length > 60) throw clientError('Button label must be 60 characters or fewer.');
  if (Boolean(buttonLabel) !== Boolean(buttonUrl)) throw clientError('Provide both a button label and a button link, or leave both blank.');
  return { format, subject, headline, message, imageUrl: format === 'html' ? imageUrl : '', buttonLabel: format === 'html' ? buttonLabel : '', buttonUrl: format === 'html' ? buttonUrl : '' };
}

function unsubscribeToken(uid) {
  const secret = String(process.env.FIREBASE_ADMIN_PRIVATE_KEY || '').trim();
  if (!secret) throw new Error('Firebase admin key is not configured.');
  return crypto.createHmac('sha256', secret).update(String(uid)).digest('hex');
}

function unsubscribeUrl(recipient) {
  if (recipient.test === true) return siteUrl();
  return `${siteUrl()}/api/marketing/unsubscribe?uid=${encodeURIComponent(recipient.uid)}&token=${encodeURIComponent(unsubscribeToken(recipient.uid))}`;
}

function campaignText(campaign, recipient) {
  return [
    'HerStep Collection',
    '',
    campaign.headline,
    '',
    campaign.message,
    campaign.buttonUrl ? `${campaign.buttonLabel}: ${campaign.buttonUrl}` : '',
    '',
    'You received this email because you opted in to HerStep Collection updates.',
    `Visit our store: ${siteUrl()}`,
    `Unsubscribe: ${unsubscribeUrl(recipient)}`,
  ].filter((line, index, list) => line !== '' || list[index - 1] !== '').join(String.fromCharCode(10));
}

function campaignHtml(campaign, recipient) {
  const unsubscribe = unsubscribeUrl(recipient);
  const paragraphs = campaign.message.split(/\r?\n/).map(line => line.trim()
    ? `<p style="margin:0 0 14px;line-height:1.65;color:#404040;">${escapeHtml(line)}</p>`
    : '<div style="height:6px"></div>').join('');
  const image = campaign.imageUrl
    ? `<img src="${escapeHtml(campaign.imageUrl)}" alt="HerStep Collection promotion" style="display:block;width:100%;max-width:560px;height:auto;border-radius:10px;margin:0 auto 22px;">`
    : '';
  const button = campaign.buttonUrl
    ? `<p style="text-align:center;margin:28px 0;"><a href="${escapeHtml(campaign.buttonUrl)}" style="display:inline-block;background:#171717;color:#fff;text-decoration:none;font-weight:700;padding:13px 24px;border-radius:7px;">${escapeHtml(campaign.buttonLabel)}</a></p>`
    : '';
  if (campaign.format === 'text') {
    return `<!doctype html><html><body style="font-family:Arial,Helvetica,sans-serif;color:#171717;line-height:1.65;max-width:600px;margin:0 auto;padding:24px;"><p>HerStep Collection</p><h1>${escapeHtml(campaign.headline)}</h1><p style="white-space:pre-line;">${escapeHtml(campaign.message)}</p>${button}<p style="font-size:12px;color:#737373;">You received this email because you opted in to HerStep Collection updates.</p><p style="font-size:12px;"><a href="${escapeHtml(unsubscribe)}">Unsubscribe from marketing emails</a></p></body></html>`;
  }
  return `<!doctype html><html><body style="margin:0;background:#f5f5f5;font-family:Arial,Helvetica,sans-serif;color:#171717;"><div style="max-width:600px;margin:0 auto;padding:24px 14px;"><div style="background:#fff;border:1px solid #e5e5e5;border-radius:14px;overflow:hidden;"><div style="background:#171717;color:#fff;padding:22px 24px;font-size:20px;font-weight:700;text-align:center;">HerStep Collection</div><div style="padding:28px 24px;"><h1 style="font-size:24px;line-height:1.3;margin:0 0 20px;">${escapeHtml(campaign.headline)}</h1>${image}${paragraphs}${button}<p style="margin:26px 0 0;color:#737373;font-size:13px;line-height:1.6;">You're receiving this email because you opted in to HerStep Collection updates.</p></div></div><p style="text-align:center;color:#737373;font-size:12px;line-height:1.6;margin:18px 0;">HerStep Collection · <a href="${siteUrl()}" style="color:#525252;">Visit our store</a><br><a href="${escapeHtml(unsubscribe)}" style="color:#525252;">Unsubscribe from marketing emails</a></p></div></body></html>`;
}

function plainTextHtml(campaign) {
  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:600px;margin:0 auto;padding:24px;color:#171717;"><h1>${escapeHtml(campaign.headline)}</h1><p style="white-space:pre-line;line-height:1.6;">${escapeHtml(campaign.message)}</p>${campaign.buttonUrl ? `<p><a href="${escapeHtml(campaign.buttonUrl)}">${escapeHtml(campaign.buttonLabel)}</a></p>` : ''}</div>`;
}

function iso(value) {
  return value?.toDate ? value.toDate().toISOString() : value || null;
}

export async function adminEmailCampaigns(req, res) {
  await requireAdmin(req);
  if (req.method === 'GET') {
    const snap = await adminDb.collection('emailCampaigns').orderBy('createdAt', 'desc').limit(20).get();
    const campaigns = snap.docs.map(doc => {
      const row = doc.data();
      return {
        id: doc.id,
        subject: row.subject || '',
        headline: row.headline || '',
        status: row.status || 'UNKNOWN',
        recipients: Number(row.recipients) || 0,
        sent: Number(row.sent) || 0,
        failed: Number(row.failed) || 0,
        createdAt: iso(row.createdAt),
      };
    });
    const customers = await adminDb.collection('users').where('marketingConsent', '==', true).get();
    const eligible = customers.docs.filter(doc => emailPattern.test(String(doc.data().email || '').trim())).length;
    return res.status(200).json({ campaigns, eligibleRecipients: eligible, maxRecipients: MAX_RECIPIENTS });
  }
  if (req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);

  const admin = await requireAdmin(req);
  const campaign = validateCampaign(req.body);
  const cfg = emailConfig();
  if (!cfg.apiKey || !cfg.senders.promotions) {
    return res.status(503).json({
      sent: false,
      reason: 'not-configured',
      missing: [!cfg.apiKey && 'BREVO_API_KEY', !cfg.senders.promotions && 'BREVO_SENDER_PROMOTIONS'].filter(Boolean),
    });
  }

  if (req.body?.mode === 'test') {
    const to = String(req.body?.testTo || admin.email || '').trim().toLowerCase();
    if (!emailPattern.test(to)) throw clientError('Enter a valid test email address.');
    const recipient = { uid: admin.uid, test: true };
    const htmlContent = campaignHtml(campaign, recipient);
    const textContent = campaignText(campaign, recipient);
    try {
      await sendEmail({ purpose: 'promotions', to, subject: `[TEST] ${campaign.subject}`, htmlContent, textContent }, cfg);
      return res.status(200).json({ sent: true, to });
    } catch (error) {
      console.error('[admin/email-campaigns] test email failed:', error?.message || error);
      return res.status(502).json({ sent: false, reason: 'send-failed', detail: 'Brevo could not deliver the test email. Check the sender configuration and Brevo logs.' });
    }
  }

  if (req.body?.mode !== 'send') throw clientError("mode must be 'test' or 'send'.");
  const usersSnap = await adminDb.collection('users').where('marketingConsent', '==', true).get();
  const recipients = usersSnap.docs
    .map(doc => ({ uid: doc.id, email: String(doc.data().email || '').trim().toLowerCase() }))
    .filter(user => emailPattern.test(user.email));
  if (!recipients.length) throw clientError('There are no customers with a valid email who have opted in to marketing.');
  if (recipients.length > MAX_RECIPIENTS) {
    throw clientError(`This campaign has ${recipients.length} eligible recipients. The safe limit per campaign is ${MAX_RECIPIENTS}; please split the audience before sending.`, 413);
  }

  const campaignId = crypto.randomUUID();
  const campaignRef = adminDb.collection('emailCampaigns').doc(campaignId);
  const htmlFor = recipient => campaignHtml(campaign, recipient);
  const batchLimit = 400;
  for (let offset = 0; offset < recipients.length; offset += batchLimit) {
    const batch = adminDb.batch();
    for (const recipient of recipients.slice(offset, offset + batchLimit)) {
      const key = `CAMPAIGN-${campaignId}-${recipient.uid}`;
      batch.set(adminDb.collection('emailOutbox').doc(emailId(key)), {
        key,
        purpose: 'promotions',
        to: recipient.email,
        subject: campaign.subject,
        htmlContent: htmlFor(recipient),
        textContent: campaignText(campaign, recipient),
        status: 'PENDING',
        attachInvoiceFor: null,
        createdAt: FieldValue.serverTimestamp(),
        sentAt: null,
        lastError: null,
        campaignId,
      });
    }
    await batch.commit();
  }

  await campaignRef.set({
    subject: campaign.subject,
    headline: campaign.headline,
    message: campaign.message,
    format: campaign.format,
    imageUrl: campaign.imageUrl || null,
    buttonLabel: campaign.buttonLabel || null,
    buttonUrl: campaign.buttonUrl || null,
    status: 'QUEUED',
    recipients: recipients.length,
    sent: 0,
    failed: 0,
    createdBy: admin.uid,
    createdAt: FieldValue.serverTimestamp(),
    updatedAt: FieldValue.serverTimestamp(),
  });

  waitUntil((async () => {
    let sent = 0;
    let failed = 0;
    const concurrency = 5;
    for (let i = 0; i < recipients.length; i += concurrency) {
      const chunk = recipients.slice(i, i + concurrency);
      const results = await Promise.all(chunk.map(recipient =>
        deliverQueuedEmail(adminDb, emailId(`CAMPAIGN-${campaignId}-${recipient.uid}`), { cfg }),
      ));
      for (const result of results) {
        if (result.sent) sent += 1;
        else failed += 1;
      }
      await campaignRef.update({
        sent,
        failed,
        status: sent + failed >= recipients.length ? (failed ? (sent ? 'PARTIAL' : 'FAILED') : 'SENT') : 'SENDING',
        updatedAt: FieldValue.serverTimestamp(),
      }).catch(() => {});
    }
  })().catch(async error => {
    console.error('[admin/email-campaigns] delivery worker failed:', error?.message || error);
    await campaignRef.update({ status: 'PARTIAL', updatedAt: FieldValue.serverTimestamp() }).catch(() => {});
  }));

  return res.status(202).json({ queued: true, campaignId, recipients: recipients.length });
}

export async function marketingUnsubscribe(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
  const uid = String(req.query?.uid || '').trim();
  const token = String(req.query?.token || '').trim();
  if (!uid || !token || uid.length > 128) return res.status(400).send('This unsubscribe link is invalid.');
  let expected;
  try { expected = unsubscribeToken(uid); } catch { return res.status(503).send('Unsubscribe is temporarily unavailable. Please contact HerStep Collection support.'); }
  const a = Buffer.from(token);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(400).send('This unsubscribe link is invalid.');
  const userRef = adminDb.collection('users').doc(uid);
  const user = await userRef.get();
  if (!user.exists) return res.status(404).send('This account could not be found.');
  await userRef.update({ marketingConsent: false, updatedAt: FieldValue.serverTimestamp() });
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  return res.status(200).send('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="font-family:Arial,sans-serif;max-width:560px;margin:48px auto;padding:20px;color:#171717"><h1>You are unsubscribed</h1><p>You will no longer receive promotional emails from HerStep Collection. Transactional emails about your orders and account may still be sent.</p><p><a href="https://www.herstepcollection.shop">Return to HerStep Collection</a></p></body></html>');
}
