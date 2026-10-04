// Core logic for in-app tipping (M-Pesa STK). Kept free of firebase-admin and
// Vercel-only imports so scripts/test-tips.mjs can exercise every branch
// against the strict in-memory fake Firestore with an injected provider.
//
// Tips are NOT orders: nothing here ever touches orders, payments, products,
// inventory, stock or promo collections. The only shared collection is
// paymentTransactions/{base64url(eventId)} — ids are namespaced with "tip:"
// prefixes so a tip event can never collide with a payment event.
import { clientError } from './http.js';
import { normalizeKenyanPhone } from './phone.js';
import { base64url, PAYMENT_STATUS, RECONCILE_TIMEOUT_MS, toIso } from './order-core.js';

export const TIP_STATUSES = ['PENDING', 'PAID', 'FAILED', 'CANCELLED', 'TIMEOUT'];
export const TREATS = ['SODA', 'COFFEE', 'TEA', 'SNACK', 'TIP'];
export const TREAT_LABELS = { SODA: 'Soda', COFFEE: 'Coffee', TEA: 'Tea', SNACK: 'Snack', TIP: 'Just a tip' };
export const TIP_AMOUNT_MIN = 10;
export const TIP_AMOUNT_MAX = 150000;
export const TIP_MESSAGE_MAX = 200;
export const TIP_RATE_LIMIT_MAX = 5;
export const TIP_RATE_LIMIT_WINDOW_MS = 10 * 60_000;

const TIP_ID_RE = /^TIP-\d{6}$/;

// HST-<tipId> receipt, only when PAID (mirrors HSP- for order payments).
export function tipReceiptNumberFor(tipId) {
  return `HST-${String(tipId || '').toUpperCase()}`;
}

export function publicTip(id, data) {
  if (!data) return null;
  return {
    id,
    tipId: data.tipId ?? null,
    customerId: data.customerId ?? '',
    customerName: data.customerName ?? '',
    amount: Number(data.amount) || 0,
    treat: data.treat ?? 'TIP',
    treatLabel: TREAT_LABELS[data.treat] || 'Just a tip',
    message: data.message ?? '',
    phone: data.phone ?? '',
    status: data.status ?? 'PENDING',
    providerReference: data.providerReference ?? null,
    transactionReference: data.transactionReference ?? null,
    receiptNumber: data.receiptNumber ?? null,
    failureReason: data.failureReason ?? null,
    createdAt: toIso(data.createdAt),
    updatedAt: toIso(data.updatedAt),
    initiatedAt: toIso(data.initiatedAt),
    completedAt: toIso(data.completedAt),
  };
}

// ---- Validation (POST /api/tips/create body) -------------------------------
// Throws on anything invalid; returns the trimmed clean input. Unknown fields
// are rejected outright.
export function validateTipInput(body) {
  const source = body && typeof body === 'object' ? body : {};
  const allowed = ['amount', 'treat', 'phone', 'message'];
  for (const key of Object.keys(source)) {
    if (!allowed.includes(key)) throw clientError('Unknown tip field.');
  }
  const rawAmount = source.amount;
  // Numbers must be integers as-is (no silent truncation: KSh 99.5 is not a
  // valid tip); digit strings are accepted because the UI sends text input.
  const amount = typeof rawAmount === 'number' ? rawAmount
    : (typeof rawAmount === 'string' && /^\d+$/.test(rawAmount.trim()) ? parseInt(rawAmount.trim(), 10) : NaN);
  if (!Number.isInteger(amount)) throw clientError('Enter a whole shilling amount between KSh 10 and KSh 150,000.');
  if (amount < TIP_AMOUNT_MIN || amount > TIP_AMOUNT_MAX) {
    throw clientError(`The tip must be between KSh ${TIP_AMOUNT_MIN.toLocaleString()} and KSh ${TIP_AMOUNT_MAX.toLocaleString()}.`);
  }
  const treat = String(source.treat ?? '');
  if (!TREATS.includes(treat)) throw clientError('Choose what you would like to treat them to.');
  const phone = normalizeKenyanPhone(source.phone);
  let message = '';
  if (source.message !== undefined && source.message !== null) {
    if (typeof source.message !== 'string') throw clientError('Message must be text.');
    message = source.message.trim();
    if (message.length > TIP_MESSAGE_MAX) throw clientError(`Keep your message under ${TIP_MESSAGE_MAX} characters.`);
  }
  return { amount, treat, phone, message };
}

// In-memory per-user rate limit: 5 creates per rolling 10 minutes.
const createHits = new Map();
export function resetTipRateLimits() {
  createHits.clear();
}
export function checkTipRateLimit(uid, now = Date.now()) {
  const hits = (createHits.get(uid) || []).filter(at => now - at < TIP_RATE_LIMIT_WINDOW_MS);
  if (hits.length >= TIP_RATE_LIMIT_MAX) {
    createHits.set(uid, hits);
    throw clientError('You are sending tips too quickly. Please wait a few minutes.', 429);
  }
  hits.push(now);
  createHits.set(uid, hits);
}

// ---- Create: ONE tip document + counter in a single transaction ------------
// The STK push happens strictly OUTSIDE this function (see createTipRoute):
// a tip that already has a providerReference NEVER receives a second push.
export async function createTipCore(db, deps, { uid, name, email, input }) {
  const { serverTimestamp } = deps;
  const result = await db.runTransaction(async tx => {
    const counterRef = db.collection('counters').doc('tips');
    const counterSnap = await tx.get(counterRef);
    const sequence = (Number(counterSnap.exists ? counterSnap.data()?.sequence : 0) || 0) + 1;
    const tipId = `TIP-${String(sequence).padStart(6, '0')}`;
    const tipRef = db.collection('tips').doc(tipId);
    const tipData = {
      tipId,
      customerId: uid,
      customerName: name || '',
      customerEmail: email || '',
      amount: input.amount,
      treat: input.treat,
      message: input.message,
      phone: input.phone,
      status: PAYMENT_STATUS.PENDING,
      providerReference: null,
      transactionReference: null,
      receiptNumber: null,
      failureReason: null,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
      initiatedAt: serverTimestamp(),
      completedAt: null,
    };
    tx.set(counterRef, { sequence }, { merge: true });
    tx.set(tipRef, tipData);
    return { id: tipId, data: tipData };
  });
  return { ...result, ref: db.collection('tips').doc(result.id) };
}

// ---- Apply a verified provider result to a tip (ONE transaction) -----------
// All reads happen before any write (strict fake Firestore enforces this).
// Idempotent via paymentTransactions/{base64url(eventId)}; PAID requires the
// exact amount; late verified PAID is still accepted after TIMEOUT/FAILED/
// CANCELLED (the supporter really paid — never reject real money).
export async function applyTipResultCore(db, deps, callback) {
  const { providerReference, status, amount, eventId } = callback || {};
  if (!providerReference) throw clientError('Missing provider reference.', 400);
  if (!TIP_STATUSES.includes(status)) throw clientError('Unknown tip status.', 400);
  if (!eventId) throw clientError('Missing event id.', 400);

  const { serverTimestamp } = deps;
  const idempotencyId = base64url(eventId);
  const idemRef = db.collection('paymentTransactions').doc(idempotencyId);

  return db.runTransaction(async tx => {
    // ---- READS FIRST ----
    const prior = await tx.get(idemRef);
    if (prior.exists) {
      return { duplicate: true, status: prior.data()?.appliedStatus ?? status };
    }
    const tipsSnap = await tx.get(
      db.collection('tips').where('providerReference', '==', providerReference).limit(1),
    );
    if (tipsSnap.empty) throw clientError('Tip not found.', 404);
    const tipRef = tipsSnap.docs[0].ref;
    const tipSnap = await tx.get(tipRef);
    const tip = tipSnap.data();

    const TERMINAL = ['PAID', 'FAILED', 'CANCELLED', 'TIMEOUT'];
    const LATE_SUCCESS = TERMINAL.includes(tip.status) && status === PAYMENT_STATUS.PAID
      && ['TIMEOUT', 'FAILED', 'CANCELLED'].includes(tip.status);
    if (TERMINAL.includes(tip.status) && !LATE_SUCCESS) {
      return { duplicate: true, status: tip.status };
    }

    const paidAmount = Number(amount);
    if (!Number.isFinite(paidAmount) || paidAmount !== Number(tip.amount)) {
      throw clientError('The callback amount does not match the tip amount.', 409);
    }

    const from = tip.status;
    if (from === status) {
      tx.set(idemRef, {
        target: 'tip',
        tipId: tip.tipId,
        providerReference,
        eventType: 'STATUS_NO_CHANGE',
        appliedStatus: status,
        amount: paidAmount,
        source: callback.source || 'PRINTPAY',
        createdAt: serverTimestamp(),
      });
      return { duplicate: true, status };
    }

    // ---- WRITES ----
    const isPaid = status === PAYMENT_STATUS.PAID;
    tx.set(idemRef, {
      target: 'tip',
      tipId: tip.tipId,
      providerReference,
      eventType: `TIP_${status}`,
      appliedStatus: status,
      amount: paidAmount,
      transactionReference: callback.transactionReference || null,
      source: callback.source || 'PRINTPAY',
      createdAt: serverTimestamp(),
    });
    tx.update(tipRef, {
      status,
      transactionReference: callback.transactionReference || tip.transactionReference || null,
      failureReason: isPaid ? null : (callback.reason || `M-Pesa ${String(status).toLowerCase()}`),
      receiptNumber: isPaid ? tipReceiptNumberFor(tip.tipId) : (tip.receiptNumber ?? null),
      completedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });

    if (isPaid) {
      // Customer notification — deterministic id, same shape as order
      // notifications but pointing at the tip (no orderDocumentId).
      tx.set(db.collection('notifications').doc(`${tip.tipId}-TIP_PAID`), {
        customerId: tip.customerId,
        orderDocumentId: null,
        event: 'TIP_RECEIVED',
        title: 'Thank you for treating the team',
        body: `We received your KSh ${paidAmount.toLocaleString()} tip (${TREAT_LABELS[tip.treat] || 'Just a tip'}). Receipt ${tipReceiptNumberFor(tip.tipId)}. You made our day!`,
        readAt: null,
        createdAt: serverTimestamp(),
      });
      // Thank-you email queued INSIDE the transaction with a deterministic
      // key — a replayed webhook/poll can never double-send. Delivery runs
      // after commit, best-effort.
      try {
        if (deps.queueTipThankYouEmail) {
          deps.queueTipThankYouEmail(tx, {
            key: `${tip.tipId}-TIP-THANKYOU`,
            tip: { ...tip, status: PAYMENT_STATUS.PAID },
            receiptNumber: tipReceiptNumberFor(tip.tipId),
          });
        }
      } catch (error) {
        console.error('[tips] thank-you email queue failed:', error?.message || error);
      }
    }

    return {
      applied: true,
      duplicate: false,
      status,
      tipId: tip.tipId,
      tipDocId: tipRef.id,
      lateSuccess: LATE_SUCCESS,
      tip: {
        ...tip,
        status,
        receiptNumber: isPaid ? tipReceiptNumberFor(tip.tipId) : (tip.receiptNumber ?? null),
        failureReason: isPaid ? null : (callback.reason || `M-Pesa ${String(status).toLowerCase()}`),
        transactionReference: callback.transactionReference || tip.transactionReference || null,
      },
    };
  });
}

// ---- Route-level helpers (dependency-injected for tests) --------------------
// deps: { db, serverTimestamp, provider, requireUser, sendTelegramMessage?,
//         queueTipThankYouEmail?, deliverQueuedEmailInline?, waitUntil? }

async function loadOwnedTip(deps, user, tipId) {
  if (typeof tipId !== 'string' || !TIP_ID_RE.test(tipId)) throw clientError('Tip id is invalid.');
  const ref = deps.db.collection('tips').doc(tipId);
  const snap = await ref.get();
  if (!snap.exists) throw clientError('Tip not found.', 404);
  const data = snap.data();
  if (data.customerId !== user.uid) throw clientError('Forbidden.', 403);
  return { ref, data };
}

function afterCommit(deps, promise) {
  const settle = Promise.resolve(promise).catch(() => undefined);
  if (typeof deps.waitUntil === 'function') deps.waitUntil(settle);
  return settle;
}

function deliverQueued(deps, key) {
  if (typeof deps.deliverQueuedEmailInline !== 'function') return;
  afterCommit(deps, deps.deliverQueuedEmailInline(deps.db, key));
}

// POST /api/tips/create
export async function createTip(deps, req) {
  const user = await deps.requireUser(req);
  checkTipRateLimit(user.uid);
  const input = validateTipInput(req.body);
  const created = await createTipCore(deps.db, deps, {
    uid: user.uid,
    name: user.displayName || user.name || '',
    email: user.email || '',
    input,
  });

  // STK push OUTSIDE the transaction, exactly once per tip: only while the
  // tip still has no providerReference. If PrintPay accepted the request but
  // storing the reference failed, we surface a clear error instead of ever
  // firing a second push for the same tip document.
  let data = created.data;
  if (!data.providerReference) {
    let stk;
    try {
      stk = await deps.provider.initiateStk({ phone: data.phone, amount: data.amount });
    } catch (error) {
      await created.ref.update({
        status: PAYMENT_STATUS.FAILED,
        failureReason: 'We could not reach M-Pesa. Please try again.',
        completedAt: deps.serverTimestamp(),
        updatedAt: deps.serverTimestamp(),
      }).catch(() => undefined);
      throw error;
    }
    await created.ref.update({
      providerReference: stk.providerReference,
      initiatedAt: deps.serverTimestamp(),
      updatedAt: deps.serverTimestamp(),
    });
    data = { ...data, providerReference: stk.providerReference };
  }
  return publicTip(created.id, data);
}

// GET /api/tips/status?tipId= — owner only. Same rules as payments/status:
// poll the provider, apply any non-PENDING truth, and treat PENDING older
// than RECONCILE_TIMEOUT_MS (100 s) as TIMEOUT. A late verified PAID is
// still accepted afterwards (webhook or a later poll).
export async function tipStatus(deps, req) {
  const user = await deps.requireUser(req);
  const query = req.query || {};
  const rawTipId = Array.isArray(query.tipId) ? query.tipId[0] : query.tipId;
  const { ref, data } = await loadOwnedTip(deps, user, rawTipId);

  let current = data;
  if (current.status === PAYMENT_STATUS.PENDING) {
    const initiatedMs = current.initiatedAt?.toMillis
      ? current.initiatedAt.toMillis()
      : (current.initiatedAt?.__serverTs ? 0 : Date.parse(toIso(current.initiatedAt) || '') || 0);
    // Provider truth first (best effort — polling never breaks on network).
    if (current.providerReference) {
      try {
        const result = await deps.provider.checkStatus(current.providerReference);
        if (result.status !== PAYMENT_STATUS.PENDING) {
          const applied = await applyTipResultCore(deps.db, deps, {
            providerReference: current.providerReference,
            status: result.status,
            amount: result.amount ?? current.amount,
            transactionReference: result.transactionReference,
            eventId: result.eventId || `tip-poll:${current.providerReference}:${result.status}`,
            source: 'PRINTPAY',
            reason: result.reason || null,
          }).catch(error => {
            if (error?.statusCode === 404) return null; // lost race with webhook
            throw error;
          });
          if (applied?.tip) {
            current = applied.tip;
            if (applied.status === PAYMENT_STATUS.PAID) deliverQueued(deps, `${applied.tipId}-TIP-THANKYOU`);
          }
          const refreshed = await ref.get();
          if (refreshed.exists) current = refreshed.data();
        }
      } catch (error) {
        console.error(`tips.status poll failed for ${rawTipId}:`, error?.message || error);
      }
    }
    // Shared 100-second rule: a dead prompt never lives longer here than
    // anywhere else.
    if (current.status === PAYMENT_STATUS.PENDING
      && initiatedMs != null && initiatedMs > 0
      && Date.now() - initiatedMs > RECONCILE_TIMEOUT_MS) {
      const applied = await applyTipResultCore(deps.db, deps, {
        providerReference: current.providerReference || `tip:${current.tipId}`,
        status: PAYMENT_STATUS.TIMEOUT,
        amount: Number(current.amount),
        transactionReference: null,
        eventId: `tip-reconcile-timeout:${current.tipId}`,
        source: 'SYSTEM',
        reason: 'The M-Pesa request timed out or was cancelled.',
      }).catch(error => {
        if (error?.statusCode === 404) return null;
        throw error;
      });
      if (applied?.tip) current = applied.tip;
      const refreshed = await ref.get();
      if (refreshed.exists) current = refreshed.data();
    }
  }
  return publicTip(String(rawTipId), current);
}

// POST /api/tips/cancel {tipId} — final checkStatus; PAID returns PAID
// (never cancel real money); otherwise CANCELLED "You cancelled the payment."
// A late verified PAID still lands via applyTipResultCore's late-success path.
export async function cancelTip(deps, req) {
  const user = await deps.requireUser(req);
  const { data } = await loadOwnedTip(deps, user, req.body?.tipId);

  let current = data;
  if (current.status === PAYMENT_STATUS.PENDING) {
    let nextStatus = PAYMENT_STATUS.CANCELLED;
    let reason = 'You cancelled the payment.';
    let transactionReference = null;
    if (current.providerReference) {
      try {
        const result = await deps.provider.checkStatus(current.providerReference);
        if (result.status === PAYMENT_STATUS.PAID) {
          nextStatus = PAYMENT_STATUS.PAID;
          reason = null;
          transactionReference = result.transactionReference || null;
        }
      } catch (error) {
        // Provider unreachable: honour the customer's cancel. If the money
        // actually landed later, the webhook/poll applies it (late success).
        console.error(`tips.cancel checkStatus failed for ${current.tipId}:`, error?.message || error);
      }
    }
    try {
      const applied = await applyTipResultCore(deps.db, deps, {
        providerReference: current.providerReference || `tip:${current.tipId}`,
        status: nextStatus,
        amount: Number(current.amount),
        transactionReference,
        eventId: `tip-cancel:${current.tipId}:${nextStatus}`,
        source: 'CUSTOMER',
        reason,
      });
      if (applied?.tip) {
        current = applied.tip;
        if (applied.status === PAYMENT_STATUS.PAID) deliverQueued(deps, `${applied.tipId}-TIP-THANKYOU`);
      }
    } catch (error) {
      if (error?.statusCode !== 409) throw error; // 409 = concurrent terminal change, return truth below
    }
  }
  return publicTip(current.tipId, current);
}

// GET /api/tips — the user's own tips. Single-field equality query, sorted in
// memory (no composite indexes).
export async function listTips(deps, req) {
  const user = await deps.requireUser(req);
  const snap = await deps.db.collection('tips').where('customerId', '==', user.uid).get();
  const tips = snap.docs
    .map(doc => publicTip(doc.id, doc.data()))
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return { tips };
}

// Best-effort reconciliation of PENDING tips (used by GET /api/admin/tips).
// Never throws, never blocks the response.
export async function reconcilePendingTips(deps, { maxAgeMs = RECONCILE_TIMEOUT_MS, now = Date.now() } = {}) {
  try {
    const snap = await deps.db.collection('tips').where('status', '==', PAYMENT_STATUS.PENDING).get();
    let changed = 0;
    for (const doc of snap.docs) {
      const tip = doc.data();
      const initiatedMs = tip.initiatedAt?.toMillis ? tip.initiatedAt.toMillis() : null;
      if (initiatedMs == null || now - initiatedMs < maxAgeMs) continue;
      let result = null;
      try {
        if (tip.providerReference) result = await deps.provider.checkStatus(tip.providerReference);
      } catch { result = null; }
      const status = result && result.status !== PAYMENT_STATUS.PENDING
        ? result.status
        : PAYMENT_STATUS.TIMEOUT;
      try {
        await applyTipResultCore(deps.db, deps, {
          providerReference: result?.providerReference || tip.providerReference || `tip:${tip.tipId}`,
          status,
          amount: Number(result?.amount ?? tip.amount),
          transactionReference: result?.transactionReference || null,
          eventId: `tip-reconcile:${tip.tipId}:${status}`,
          source: 'SYSTEM',
          reason: result?.reason || 'The M-Pesa request timed out or was cancelled.',
        });
        changed += 1;
      } catch { /* another process got there first */ }
    }
    return { scanned: snap.docs.length, changed };
  } catch (error) {
    console.error('[tips] reconcile pending failed:', error?.message || error);
    return { scanned: 0, changed: 0 };
  }
}

// GET /api/admin/tips — newest first, phone masked to last 4 digits, totals
// computed ONLY from PAID tips.
export async function adminTips(deps, req, { now = Date.now() } = {}) {
  await deps.requireAdmin(req);
  const snap = await deps.db.collection('tips').get();
  const all = snap.docs.map(doc => publicTip(doc.id, doc.data()));
  all.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));

  const paid = all.filter(tip => tip.status === PAYMENT_STATUS.PAID);
  const dateOf = tip => {
    const iso = tip.completedAt || tip.createdAt;
    const ms = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(ms) ? new Date(ms) : null;
  };
  const nowDate = new Date(now);
  const sameDay = d => d && d.getFullYear() === nowDate.getFullYear()
    && d.getMonth() === nowDate.getMonth() && d.getDate() === nowDate.getDate();
  const sameMonth = d => d && d.getFullYear() === nowDate.getFullYear() && d.getMonth() === nowDate.getMonth();

  const totals = { today: 0, thisMonth: 0, allTime: 0, paidCount: paid.length };
  const byTreat = {};
  for (const tip of paid) {
    totals.allTime += tip.amount;
    const d = dateOf(tip);
    if (sameDay(d)) totals.today += tip.amount;
    if (sameMonth(d)) totals.thisMonth += tip.amount;
    byTreat[tip.treat] = (byTreat[tip.treat] || 0) + tip.amount;
  }

  const rows = all.map(tip => ({
    ...tip,
    phone: tip.phone ? String(tip.phone).slice(-4) : '',
  }));

  return { tips: rows, totals, byTreat };
}
