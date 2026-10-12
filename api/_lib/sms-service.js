// HashBack transactional SMS outbox.
// SMS is queued in the same Firestore transaction as the verified business event,
// then delivered after commit. Provider credentials are server-side only.
import { FieldValue } from 'firebase-admin/firestore';

const HASHBACK_SEND_URL = 'https://api.hashback.co.ke/sms/send';
const HASHBACK_STATUS_URL = 'https://api.hashback.co.ke/sms/status';

const env = () => globalThis.process?.env || {};
export function smsConfig() {
  return {
    apiKey: String(env().HASH_API_KEY || env().HASHBACK_SMS_API_KEY || '').trim(),
    senderId: String(env().HASHBACK_SMS_SENDER_ID || '').trim(),
  };
}
export function smsId(key) {
  return String(key || '').replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 180);
}
function cleanPhone(value) {
  const raw = String(value || '').trim().replace(/[\s()-]/g, '');
  if (/^0[17]\d{8}$/.test(raw)) return '+254' + raw.slice(1);
  if (/^254[17]\d{8}$/.test(raw)) return '+' + raw;
  if (/^\+254[17]\d{8}$/.test(raw)) return raw;
  return '';
}

// Queue in a business transaction. Deterministic key = no duplicate SMS for
// the same event when a webhook or admin request is replayed.
export function queueSms(tx, db, { key, to, message }) {
  const phone = cleanPhone(to);
  const body = String(message || '').trim();
  if (!key || !phone || !body) return false;
  tx.set(db.collection('smsOutbox').doc(smsId(key)), {
    key: String(key), to: phone, message: body.slice(0, 1000),
    status: 'PENDING', providerMessageId: null, lastError: null,
    createdAt: FieldValue.serverTimestamp(), sentAt: null, updatedAt: FieldValue.serverTimestamp(),
  }, { merge: false });
  return true;
}

// Best-effort delivery. Never throw into order/payment/tip processing.
export async function deliverQueuedSms(db, key, { fetchImpl = globalThis.fetch, config = smsConfig() } = {}) {
  const id = smsId(key);
  try {
    if (!config.apiKey) {
      console.warn('[sms] skipped: HASH_API_KEY is not configured in Vercel.');
      return { sent: false, reason: 'not-configured' };
    }
    const ref = db.collection('smsOutbox').doc(id);
    const claimed = await db.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists) return null;
      const data = snap.data();
      if (data.status !== 'PENDING') return null;
      tx.update(ref, { status: 'SENDING', updatedAt: FieldValue.serverTimestamp() });
      return data;
    });
    if (!claimed) return { sent: false, reason: 'already-queued-or-sending' };

    const payload = { to: claimed.to, message: claimed.message };
    if (config.senderId) payload.sender_id = config.senderId;
    const response = await fetchImpl(HASHBACK_SEND_URL, {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + config.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    let result = {};
    try { result = await response.json(); } catch { /* provider may return non-JSON */ }
    if (!response.ok || result?.success === false || result?.status === 'FAILED') {
      const detail = String(result?.message || result?.error || ('HTTP ' + response.status)).slice(0, 300);
      await ref.update({ status: 'PENDING', lastError: detail, updatedAt: FieldValue.serverTimestamp() }).catch(() => {});
      console.error('[sms] HashBack send failed for', id + ':', detail);
      return { sent: false, reason: detail };
    }
    await ref.update({
      status: 'SENT',
      providerMessageId: result?.id ?? result?.message_id ?? null,
      providerStatus: result?.status ?? 'ACCEPTED',
      units: result?.units ?? null,
      cost: result?.cost ?? null,
      lastError: null,
      sentAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { sent: true, id: result?.id ?? result?.message_id ?? null };
  } catch (error) {
    console.error('[sms] delivery failed for', id + ':', error?.message || error);
    await db.collection('smsOutbox').doc(id).update({
      status: 'PENDING', lastError: String(error?.message || error).slice(0, 300),
      updatedAt: FieldValue.serverTimestamp(),
    }).catch(() => {});
    return { sent: false, reason: 'delivery-error' };
  }
}

// Optional provider status check for admin diagnostics; never exposes the API key.
export async function checkHashbackSmsStatus(messageId, { fetchImpl = globalThis.fetch, config = smsConfig() } = {}) {
  if (!config.apiKey || !messageId) return null;
  try {
    const url = HASHBACK_STATUS_URL + '?id=' + encodeURIComponent(String(messageId));
    const response = await fetchImpl(url, { headers: { Authorization: 'Bearer ' + config.apiKey } });
    if (!response.ok) return null;
    return await response.json();
  } catch { return null; }
}


// Best-effort bounded retry sweep, invoked by admin activity just like email retry.
export async function retryPendingSms(db, { limit = 5 } = {}) {
  try {
    const snap = await db.collection('smsOutbox').where('status', '==', 'PENDING').limit(Math.max(1, Math.min(20, Number(limit) || 5))).get();
    const results = await Promise.all(snap.docs.map(doc => deliverQueuedSms(db, doc.data()?.key || doc.id)));
    return { attempted: results.length, sent: results.filter(r => r?.sent).length };
  } catch (error) {
    console.error('[sms] retry sweep failed:', error?.message || error);
    return { attempted: 0, sent: 0 };
  }
}
