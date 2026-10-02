// Payment routes (dispatched from api/payments.js):
//   POST /api/payments/stk/initiate  — create or reuse a PENDING payment in a
//          Firestore transaction, then (OUTSIDE the transaction) send ONE
//          PrintPay STK push. A payment that already has a providerReference
//          never receives a second push.
//   GET  /api/payments/status        — owner only; reconciles THAT payment
//          first (provider truth applied through applyVerifiedCallbackCore),
//          then returns the fresh state.
//   POST /api/payments/mpesa/callback— public webhook. verifyCallback() is
//          only a hint: PAID must be RE-CONFIRMED with checkStatus() before
//          anything is applied. Idempotent via paymentTransactions/{eventId}.
//   GET  /api/payments/receipt       — owner only, PAID only.
//   POST /api/payments/cancel        — owner only; final provider.checkStatus
//          then apply PAID (if truly paid) or CANCELLED ("You cancelled the
//          payment."). A later verified PAID still lands via the late-success
//          path in applyVerifiedCallbackCore.
import { FieldValue } from 'firebase-admin/firestore';
import { adminDb, requireUser } from '../firebase-admin.js';
import { getMpesaProvider } from '../mpesa-provider.js';
import { clientError, methodNotAllowed } from '../http.js';
import {
  PAYMENT_STATUS,
  RECONCILE_TIMEOUT_MS, // single source of truth — no local window constant
  applyVerifiedCallbackCore,
  reconcileBestEffort,
  publicPayment,
} from '../order-core.js';

// Reconcile ONE payment immediately (used by GET /api/payments/status).
// Best effort: any failure just leaves the stored state to be returned.
async function reconcileOne(paymentId, data) {
  if (data.status !== PAYMENT_STATUS.PENDING || !data.providerReference) return data;
  try {
    const provider = getMpesaProvider();
    const result = await provider.checkStatus(data.providerReference);
    if (result.status !== PAYMENT_STATUS.PENDING) {
      await applyVerifiedCallbackCore(adminDb, { serverTimestamp: () => FieldValue.serverTimestamp() }, {
        providerReference: data.providerReference,
        status: result.status,
        amount: result.amount ?? data.amount,
        transactionReference: result.transactionReference,
        eventId: result.eventId || `poll:${data.providerReference}:${result.status}`,
        source: 'PRINTPAY',
        reason: result.reason || null,
      });
      const refreshed = await adminDb.collection('payments').doc(paymentId).get();
      if (refreshed.exists) return refreshed.data();
    } else {
      // Provider still says PENDING — apply the shared 100-second rule so a
      // dead prompt never lives longer here than anywhere else (TIMEOUT is
      // applied via applyVerifiedCallbackCore with stock restored ONCE).
      const initiatedMs = data.initiatedAt?.toMillis ? data.initiatedAt.toMillis() : null;
      if (initiatedMs != null && Date.now() - initiatedMs > RECONCILE_TIMEOUT_MS) {
        await applyVerifiedCallbackCore(adminDb, { serverTimestamp: () => FieldValue.serverTimestamp() }, {
          providerReference: data.providerReference,
          status: PAYMENT_STATUS.TIMEOUT,
          amount: Number(data.amount),
          transactionReference: null,
          eventId: `reconcile-timeout:${paymentId}`,
          source: 'SYSTEM',
          reason: 'The M-Pesa request timed out or was cancelled.',
        }).catch(error => console.error(`payments timeout-rule failed for ${paymentId}:`, error?.message || error));
        const refreshed = await adminDb.collection('payments').doc(paymentId).get();
        if (refreshed.exists) return refreshed.data();
      }
    }
  } catch (error) {
    console.error(`payments reconcile-one failed for ${paymentId}:`, error?.message || error);
  }
  return data;
}


function shape(id, data) {
  return publicPayment(id, data);
}

// Find the reusable PENDING payment for an order, if any.
async function findActivePending(orderDocId) {
  const snap = await adminDb.collection('payments')
    .where('orderDocumentId', '==', orderDocId)
    .where('status', '==', PAYMENT_STATUS.PENDING)
    .limit(1)
    .get();
  return snap.empty ? null : snap.docs[0];
}

export async function initiate(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
  const u = await requireUser(req);
  const orderDocId = req.body?.orderDocumentId;
  if (typeof orderDocId !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(orderDocId)) {
    throw clientError('Order id is invalid.');
  }

  // ---- Reconcile FIRST (OUTSIDE any transaction — provider HTTP calls must
  // never run inside one): if a previous attempt is still marked PENDING but
  // the provider already says it died (webhook lost, browser closed), apply
  // the truth now so the order leaves "Pending" and Try again starts a fresh
  // push instead of reusing a dead prompt. Best-effort — never blocks.
  // SPEED: skipped entirely when the order has no activePaymentId (no previous
  // attempt to reconcile).
  try {
    const pre = await adminDb.collection('orders').doc(orderDocId).get();
    const preActive = pre.exists ? pre.data()?.activePaymentId : null;
    if (typeof preActive === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(preActive)) {
      const pSnap = await adminDb.collection('payments').doc(preActive).get();
      if (pSnap.exists && pSnap.data().status === PAYMENT_STATUS.PENDING && pSnap.data().providerReference) {
        const result = await getMpesaProvider().checkStatus(pSnap.data().providerReference);
        if (result.status !== PAYMENT_STATUS.PENDING) {
          await applyVerifiedCallbackCore(adminDb, { serverTimestamp: () => FieldValue.serverTimestamp() }, {
            providerReference: pSnap.data().providerReference,
            status: result.status,
            amount: result.amount ?? pSnap.data().amount,
            transactionReference: result.transactionReference,
            eventId: `pre-initiate:${pSnap.data().providerReference}:${result.status}`,
            source: 'PRINTPAY',
            reason: result.reason || null,
          });
        }
      }
    }
  } catch (error) {
    console.error('payments.initiate reconcile failed:', error?.message || error);
  }

  // ---- Transaction: create OR reuse the PENDING payment + set activePaymentId.
  // The provider STK push itself happens strictly OUTSIDE this transaction.
  const plan = await adminDb.runTransaction(async tx => {
    const orderRef = adminDb.collection('orders').doc(orderDocId);
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists) throw clientError('Order not found.', 404);
    const order = orderSnap.data();
    if (order.customerId !== u.uid) throw clientError('Forbidden.', 403);
    if (order.paymentStatus !== PAYMENT_STATUS.PENDING || order.orderStatus === 'CANCELLED') {
      throw clientError('This order cannot be paid right now.', 409);
    }

    const existing = await findActivePending(orderDocId);
    if (existing && existing.exists) {
      const data = existing.data();
      const initiatedAtMs = data.initiatedAt?.toMillis ? data.initiatedAt.toMillis() : Date.now();
      const fresh = Date.now() - initiatedAtMs < RECONCILE_TIMEOUT_MS;
      if (fresh) {
        if (order.activePaymentId !== existing.id) {
          tx.update(orderRef, { activePaymentId: existing.id, updatedAt: FieldValue.serverTimestamp() });
        }
        // Reusing a fresh PENDING payment: send the STK push ONLY when it has
        // no providerReference yet (a previous attempt died before PrintPay
        // answered). Once a providerReference exists we NEVER push twice —
        // the customer just confirms that same prompt or waits for timeout.
        return { paymentRef: existing.ref, data, sendStk: !data.providerReference };
      }
      // Stale attempt (> RECONCILE_TIMEOUT_MS): terminalise it as TIMEOUT and
      // start a NEW push. applyVerifiedCallbackCore restores any reserved
      // stock exactly once (guarded by order.inventoryReserved).
      tx.update(existing.ref, { status: PAYMENT_STATUS.TIMEOUT, failureReason: 'The M-Pesa request timed out or was cancelled.', completedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    }

    const phone = typeof order.delivery?.phone === 'string' ? order.delivery.phone : '';
    if (!/^\+254[17]\d{8}$/.test(phone)) throw clientError('The order phone number is not valid for M-Pesa.');
    const paymentRef = adminDb.collection('payments').doc();
    const paymentData = {
      paymentId: paymentRef.id,
      receiptNumber: null,
      orderDocumentId: orderDocId,
      orderId: order.orderId,
      customerId: u.uid,
      amount: Number(order.total),
      currency: 'KES',
      phone,
      method: 'MPESA',
      status: PAYMENT_STATUS.PENDING,
      providerReference: null,
      transactionReference: null,
      failureReason: null,
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
      initiatedAt: FieldValue.serverTimestamp(),
      completedAt: null,
    };
    tx.set(paymentRef, paymentData);
    tx.update(orderRef, { activePaymentId: paymentRef.id, updatedAt: FieldValue.serverTimestamp() });
    return { paymentRef, data: paymentData, sendStk: true };
  });

  // ---- Provider call OUTSIDE the transaction. Only ever sent when the
  // payment has no providerReference yet — never a second STK for the same
  // payment document.
  let data = plan.data;
  if (plan.sendStk && !data.providerReference) {
    const provider = getMpesaProvider();
    const stk = await provider.initiateStk({ phone: data.phone, amount: data.amount });
    await plan.paymentRef.update({ providerReference: stk.providerReference, updatedAt: FieldValue.serverTimestamp() });
    data = { ...data, providerReference: stk.providerReference };
  }

  return res.status(202).json({ payment: shape(plan.paymentRef.id, data) });
}

export async function status(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
  const u = await requireUser(req);
  const paymentId = Array.isArray(req.query.paymentId) ? req.query.paymentId[0] : req.query.paymentId;
  if (typeof paymentId !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(paymentId)) throw clientError('Payment id is invalid.');

  const paymentRef = adminDb.collection('payments').doc(paymentId);
  const paymentSnap = await paymentRef.get();
  if (!paymentSnap.exists) throw clientError('Payment not found.', 404);
  let data = paymentSnap.data();
  if (data.customerId !== u.uid) throw clientError('Forbidden.', 403);

  // Reconcile THIS payment immediately (no minimum age beyond ~3 s so a lost
  // webhook or a cancelled prompt surfaces within one or two polls instead of
  // waiting for the 100-second timeout). Best effort — never breaks polling.
  if (data.status === PAYMENT_STATUS.PENDING) {
    const initiatedMs = data.initiatedAt?.toMillis ? data.initiatedAt.toMillis() : 0;
    if (!initiatedMs || Date.now() - initiatedMs > 3_000) {
      data = await reconcileOne(paymentId, data);
    }
  }

  return res.json({ payment: shape(paymentId, data) });
}

// POST /api/payments/cancel — owner only, body {paymentId}.
// The customer clicked "I cancelled / I didn't get the prompt". We do ONE
// final provider.checkStatus first so we never cancel real money:
//   PAID     -> apply it and return PAID (late-success path covers webhooks).
//   PENDING  -> apply CANCELLED with reason "You cancelled the payment."
//              (stock released once, guarded by order.inventoryReserved).
//   terminal -> returned unchanged.
export async function cancel(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
  const u = await requireUser(req);
  const paymentId = req.body?.paymentId;
  if (typeof paymentId !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(paymentId)) throw clientError('Payment id is invalid.');

  const paymentRef = adminDb.collection('payments').doc(paymentId);
  const paymentSnap = await paymentRef.get();
  if (!paymentSnap.exists) throw clientError('Payment not found.', 404);
  let data = paymentSnap.data();
  if (data.customerId !== u.uid) throw clientError('Forbidden.', 403);

  if (data.status === PAYMENT_STATUS.PENDING) {
    let nextStatus = PAYMENT_STATUS.CANCELLED;
    let reason = 'You cancelled the payment.';
    let transactionReference = null;
    if (data.providerReference) {
      try {
        const provider = getMpesaProvider();
        const result = await provider.checkStatus(data.providerReference);
        if (result.status === PAYMENT_STATUS.PAID) {
          nextStatus = PAYMENT_STATUS.PAID;
          reason = null;
          transactionReference = result.transactionReference || null;
        }
      } catch (error) {
        // Provider unreachable: honour the customer's cancel. If the money
        // actually landed later, the webhook/poll applies it via the
        // late-success path in applyVerifiedCallbackCore.
        console.error(`payments.cancel checkStatus failed for ${paymentId}:`, error?.message || error);
      }
    }
    try {
      await applyVerifiedCallbackCore(adminDb, { serverTimestamp: () => FieldValue.serverTimestamp() }, {
        providerReference: data.providerReference || `cancel:${paymentId}`,
        status: nextStatus,
        amount: Number(data.amount),
        transactionReference,
        eventId: `cancel:${paymentId}:${nextStatus}`,
        source: 'CUSTOMER',
        reason,
      });
    } catch (error) {
      if (error?.statusCode === 409) {
        // Already terminalised concurrently (webhook race) — return the truth.
        const refreshed = await paymentRef.get();
        if (refreshed.exists) data = refreshed.data();
      } else {
        throw error;
      }
    }
    const refreshed = await paymentRef.get();
    if (refreshed.exists) data = refreshed.data();
  }

  return res.json({ payment: shape(paymentId, data) });
}

// POST /api/payments/mpesa/callback — PUBLIC PrintPay webhook.
//
// CRITICAL RULE: this endpoint MUST ALWAYS ANSWER HTTP 200 to PrintPay.
// PrintPay's "Test Link" sends a fake/empty payload and marks the URL broken
// on any non-200 response, so every failure path (unknown checkout id, empty
// or malformed body, unconfirmed PAID, thrown errors) is logged with
// console.error and answered 200 {ok:true, received:true, applied:false}.
// GET/HEAD return 200 {ok:true} as a link health check; other methods return
// 200 {ok:true, ignored:true}.
//
// Security is unchanged: PAID is applied ONLY after provider.checkStatus
// re-confirms the same checkout id (and the exact amount inside
// applyVerifiedCallbackCore). Cancel/failed/timeout results (codes 1032,
// 1037, 2001, 1 or any non-success status) are applied directly with the
// friendly failureReason. Every call records settings/printpay so the admin
// Payments tab can show "last callback received …".
export async function mpesaCallback(req, res) {
  const send = (payload) => res.status(200).json(payload);

  if (req.method === 'GET' || req.method === 'HEAD') {
    return send({ ok: true });
  }
  if (req.method !== 'POST') {
    return send({ ok: true, ignored: true });
  }

  // ---- Webhook visibility: one safe log line per call + a settings doc the
  // admin Payments tab reads ("last callback received …"). Only checkout id,
  // status, result code and the LAST 4 phone digits are ever logged/stored.
  const cbBody = (req.body && typeof req.body === 'object') ? req.body : {};
  const extractCheckoutId = () => String(
    cbBody.checkout_request_id ?? cbBody.CheckoutRequestID ?? cbBody.checkoutRequestId
    ?? cbBody.CheckoutData?.CheckoutRequestID ?? '',
  );
  const recordCallback = async (statusValue, checkoutId) => {
    const rawPhone = String(cbBody.msisdn || cbBody.phone || cbBody.Phone || '');
    const logFields = {
      lastCallbackAt: new Date().toISOString(),
      lastCallbackStatus: statusValue ?? 'UNRECOGNISED',
      lastCallbackCheckoutId: checkoutId || null,
      lastResultCode: String(cbBody.result_code ?? cbBody.ResultCode ?? ''),
      phoneLast4: rawPhone ? rawPhone.slice(-4) : null,
    };
    console.log(`mpesa-callback checkout=${logFields.lastCallbackCheckoutId ?? '-'} status=${logFields.lastCallbackStatus} code=${logFields.lastResultCode || '-'} phone=…${logFields.phoneLast4 ?? '????'}`);
    try {
      await adminDb.collection('settings').doc('printpay').set(
        { ...logFields, updatedAt: FieldValue.serverTimestamp() },
        { merge: true },
      );
    } catch (error) {
      console.error('mpesa-callback settings/printpay write failed:', error?.message || error);
    }
  };

  let verified = null;
  try {
    const provider = getMpesaProvider();
    verified = await provider.verifyCallback(req);
  } catch (error) {
    // Malformed/garbage/fake-test payload — verifyCallback threw. Log it and
    // still answer 200 so PrintPay never sees an error.
    console.error('mpesa-callback verifyCallback failed:', error?.message || error);
    await recordCallback('UNRECOGNISED', extractCheckoutId());
    return send({ ok: true, received: true, applied: false });
  }

  await recordCallback(verified?.status ?? 'UNRECOGNISED', verified?.providerReference || extractCheckoutId());

  if (!verified?.providerReference) {
    console.error('mpesa-callback: unrecognised payload (no checkout id) — acknowledged with 200');
    return send({ ok: true, received: true, applied: false });
  }

  try {
    let applied;
    if (verified.status === PAYMENT_STATUS.PAID) {
      // NEVER trust the webhook alone: re-confirm with an explicit status query
      // and require the SAME checkout id before marking anything PAID.
      const provider = getMpesaProvider();
      const confirmation = await provider.checkStatus(verified.providerReference);
      if (confirmation.status !== PAYMENT_STATUS.PAID
        || String(confirmation.providerReference) !== String(verified.providerReference)) {
        console.error(`mpesa-callback: unconfirmed PAID for ${verified.providerReference} (provider says ${confirmation.status}) — acknowledged with 200`);
        return send({ ok: true, received: true, applied: false });
      }
      applied = await applyVerifiedCallbackCore(adminDb, { serverTimestamp: () => FieldValue.serverTimestamp() }, {
        providerReference: verified.providerReference,
        status: PAYMENT_STATUS.PAID,
        amount: confirmation.amount ?? verified.amount,
        transactionReference: confirmation.transactionReference || verified.transactionReference,
        eventId: verified.eventId || `callback:${verified.providerReference}:PAID`,
        source: 'PRINTPAY',
        reason: confirmation.reason ?? verified.reason ?? null,
      });
    } else {
      applied = await applyVerifiedCallbackCore(adminDb, { serverTimestamp: () => FieldValue.serverTimestamp() }, {
        providerReference: verified.providerReference,
        status: verified.status,
        amount: verified.amount,
        transactionReference: verified.transactionReference,
        eventId: verified.eventId || `callback:${verified.providerReference}:${verified.status}`,
        source: 'PRINTPAY',
        reason: verified.reason || null,
      });
    }
    return send({ ok: true, applied: applied?.applied !== false, duplicate: applied?.duplicate === true });
  } catch (error) {
    // Unknown payment, amount mismatch (409), Firestore failure… PrintPay
    // STILL gets a 200; the truth is in the log and reconciliation/polling
    // will converge the state anyway.
    console.error(`mpesa-callback apply failed for ${verified.providerReference}:`, error?.message || error, error?.stack || '');
    return send({ ok: true, received: true, applied: false });
  }
}

export async function receipt(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
  const u = await requireUser(req);
  const paymentId = Array.isArray(req.query.paymentId) ? req.query.paymentId[0] : req.query.paymentId;
  if (typeof paymentId !== 'string' || !/^[A-Za-z0-9_-]{8,80}$/.test(paymentId)) throw clientError('Payment id is invalid.');

  const paymentSnap = await adminDb.collection('payments').doc(paymentId).get();
  if (!paymentSnap.exists) throw clientError('Payment not found.', 404);
  const data = paymentSnap.data();
  if (data.customerId !== u.uid) throw clientError('Forbidden.', 403);
  if (data.status !== PAYMENT_STATUS.PAID) throw clientError('A receipt is available only after the payment succeeds.', 409);

  const orderSnap = await adminDb.collection('orders').doc(data.orderDocumentId).get();
  const order = orderSnap.exists ? orderSnap.data() : {};
  return res.json({
    receipt: {
      receiptNumber: data.receiptNumber,
      paymentId,
      orderId: data.orderId ?? order.orderId ?? null,
      amount: Number(data.amount) || 0,
      currency: data.currency || 'KES',
      method: data.method || 'MPESA',
      transactionReference: data.transactionReference ?? null,
      completedAt: data.completedAt?.toDate ? data.completedAt.toDate().toISOString() : null,
      customerName: order.customerName ?? null,
      items: Array.isArray(order.items) ? order.items.map(i => ({ name: i.name, size: i.size, quantity: i.quantity, lineTotal: i.lineTotal })) : [],
    },
  });
}
