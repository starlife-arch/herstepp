// In-app tipping routes (dispatched from api/payments.js):
//   POST /api/tips/create            — requireUser, rate limit 5/10 min,
//          tip PENDING + counter in ONE transaction, then ONE STK push
//          OUTSIDE the transaction (same provider helper as orders).
//   GET  /api/tips/status?tipId=     — owner only; provider poll + the shared
//          100-second TIMEOUT rule (late verified PAID still accepted).
//   POST /api/tips/cancel {tipId}    — final checkStatus; PAID returns PAID,
//          else CANCELLED "You cancelled the payment."
//   GET  /api/tips                   — the user's own tips (equality query,
//          sorted in memory).
// All business logic lives in api/_lib/tip-core.js (offline-testable); this
// file only wires firebase-admin, the PrintPay provider and notify hooks.
import { FieldValue } from 'firebase-admin/firestore';
import { waitUntil } from '@vercel/functions';
import { adminDb, requireUser } from '../firebase-admin.js';
import { getMpesaProvider } from '../mpesa-provider.js';
import { methodNotAllowed } from '../http.js';
import { sendTelegramMessage } from '../telegram.js';
import { deliverQueuedEmailInline } from '../email-service.js';
import { queueTipThankYouEmail, telegramTipReceived } from '../notify.js';
import {
  createTip,
  tipStatus,
  cancelTip,
  listTips,
  applyTipResultCore,
  publicTip,
  TREAT_LABELS,
} from '../tip-core.js';

export const tipDeps = {
  db: adminDb,
  serverTimestamp: () => FieldValue.serverTimestamp(),
  provider: getMpesaProvider(),
  requireUser,
  waitUntil,
  sendTelegramMessage,
  deliverQueuedEmailInline,
  queueTipThankYouEmail: (tx, payload) => queueTipThankYouEmail(tx, adminDb, payload),
};

// After a tip lands PAID: Telegram alert + thank-you email delivery, both
// best-effort via waitUntil — they NEVER affect orders or payments.
function announcePaidTip(tip) {
  if (!tip) return;
  waitUntil(telegramTipReceived({ ...tip, treatLabel: TREAT_LABELS[tip.treat] }).catch(() => false));
  waitUntil(deliverQueuedEmailInline(adminDb, `${tip.tipId}-TIP-THANKYOU`).catch(() => {}));
}

export async function tipsCreate(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
  const tip = await createTip(tipDeps, req);
  return res.status(201).json({ tip });
}

export async function tipsStatus(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
  const before = Array.isArray(req.query?.tipId) ? req.query.tipId[0] : req.query?.tipId;
  // Snapshot the stored status so we can tell whether THIS call just landed
  // the money (and should fire the after-commit side effects exactly once).
  const snap = await adminDb.collection('tips').doc(String(before)).get();
  const wasPending = snap.exists ? snap.data()?.status === 'PENDING' : false;
  const tip = await tipStatus(tipDeps, req);
  if (wasPending && tip?.status === 'PAID') announcePaidTip(tip);
  return res.json({ tip });
}

export async function tipsCancel(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
  const tip = await cancelTip(tipDeps, req);
  if (tip?.status === 'PAID') announcePaidTip(tip);
  return res.json({ tip });
}

export async function tipsList(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
  const result = await listTips(tipDeps, req);
  return res.json(result);
}

// Webhook branch for tips (called from mpesaCallback when no payment matches
// the checkout id). Same rules as orders: PAID must already be re-confirmed
// by the caller with provider.checkStatus; amount is checked exactly inside
// applyTipResultCore; idempotency via paymentTransactions/{base64url(eventId)}.
export async function applyTipCallback(callback) {
  const applied = await applyTipResultCore(adminDb, tipDeps, callback);
  if (applied?.applied && applied.status === 'PAID') {
    announcePaidTip(applied.tip ? { ...applied.tip, tipId: applied.tipId } : null);
  }
  return applied;
}

// Does a providerReference belong to a tip at all? Used by the webhook to
// decide tips vs "ignored" when no payment matches.
export async function findTipByProviderReference(providerReference) {
  const snap = await adminDb.collection('tips')
    .where('providerReference', '==', providerReference)
    .limit(1)
    .get();
  if (snap.empty) return null;
  const doc = snap.docs[0];
  return publicTip(doc.id, doc.data());
}
