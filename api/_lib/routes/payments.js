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
  requireInventoryArray,
  deriveStock,
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
    // PAY NOW: a customer may retry payment whenever the ORDER is still alive.
    // Allowed payment statuses to start from: PENDING (reuse/replace a fresh
    // attempt), FAILED / CANCELLED / TIMEOUT (previous attempt died — start a
    // new STK push and re-reserve stock below). PAID gets a specific message,
    // CANCELLED orders get their own — never a generic 409.
    if (order.orderStatus === 'CANCELLED') {
      throw clientError('This order was cancelled or expired. Please place a new order.', 409);
    }
    if (order.paymentStatus === PAYMENT_STATUS.PAID) {
      throw clientError('This order is already paid.', 409);
    }
    if (order.paymentStatus === PAYMENT_STATUS.REFUNDED) {
      throw clientError('This order was refunded. Please place a new order.', 409);
    }
    if (![PAYMENT_STATUS.PENDING, PAYMENT_STATUS.FAILED, PAYMENT_STATUS.CANCELLED, PAYMENT_STATUS.TIMEOUT].includes(order.paymentStatus)) {
      throw clientError('This order cannot be paid right now.', 409);
    }

    // ---- Re-reserve stock INSIDE THIS SAME TRANSACTION (all reads before all
    // writes). A previous cancel/timeout released the reservation, so paying
    // again must put it back — exactly once, never twice. When stock is short
    // we abort with a specific 409 BEFORE any write happens.
    let restockPlan = null;
    if (order.inventoryReserved !== true && order.orderStatus !== 'CANCELLED') {
      const items = Array.isArray(order.items) ? order.items : [];
      const refs = [];
      const seen = new Set();
      for (const item of items) {
        const pid = typeof item?.productId === 'string' ? item.productId : '';
        if (pid && !seen.has(pid)) {
          seen.add(pid);
          refs.push(adminDb.collection('products').doc(pid));
        }
      }
      const productSnaps = refs.length > 0 ? await tx.getAll(...refs) : [];
      const byId = new Map();
      for (const snap of productSnaps) {
        if (snap.exists) byId.set(snap.id, snap.data());
      }
      // Group quantities per (productId,size) first so two lines of the same
      // size are checked against ONE pool.
      const demand = new Map();
      for (const item of items) {
        const key = `${item.productId}::${String(item.size)}`;
        const prev = demand.get(key) || { productId: item.productId, size: String(item.size), quantity: 0 };
        prev.quantity += Number(item.quantity) || 0;
        demand.set(key, prev);
      }
      const nextInventory = new Map();
      const logs = [];
      for (const need of demand.values()) {
        if (!(need.quantity > 0)) continue;
        const data = byId.get(need.productId);
        if (!data) throw clientError(`${need.name || 'An item'} size ${need.size} is no longer in stock.`, 409);
        // requireInventoryArray() only VALIDATES (it throws a 409 when the product's
        // inventory is not an array and returns nothing), so use the array itself.
        requireInventoryArray(need.productId, data);
        const current = nextInventory.get(need.productId) || data.inventory;
        const entry = current.find(i => String(i.size) === need.size);
        if (!entry || (Number(entry.quantity) || 0) < need.quantity) {
          throw clientError(`${data.name || need.name || 'An item'} size ${need.size} is no longer in stock.`, 409);
        }
        nextInventory.set(need.productId, current.map(i => (
          String(i.size) === need.size ? { ...i, quantity: (Number(i.quantity) || 0) - need.quantity } : i
        )));
        logs.push({ productId: need.productId, size: need.size, change: -need.quantity, reason: 'PAYMENT_RETRY_RESTOCK', orderId: order.orderId });
      }
      restockPlan = { nextInventory, logs, byId };
    }

    const existing = await findActivePending(orderDocId);
    if (existing && existing.exists) {
      const data = existing.data();
      const initiatedAtMs = data.initiatedAt?.toMillis ? data.initiatedAt.toMillis() : Date.now();
      const fresh = Date.now() - initiatedAtMs < RECONCILE_TIMEOUT_MS;
      if (fresh) {
        const patch = {};
        if (order.activePaymentId !== existing.id) patch.activePaymentId = existing.id;
        // The order must mirror the live payment attempt's status (it can lag
        // as FAILED/CANCELLED/TIMEOUT while a fresh PENDING payment exists).
        if (order.paymentStatus !== PAYMENT_STATUS.PENDING) patch.paymentStatus = PAYMENT_STATUS.PENDING;
        if (Object.keys(patch).length > 0) tx.update(orderRef, { ...patch, updatedAt: FieldValue.serverTimestamp() });
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
      // Mirror on the order: this attempt is dead. If its callback later lands
      // verified PAID it still applies (late-success path); if it truly died,
      // the order now honestly reads TIMEOUT and the reservation state below
      // decides whether stock needs re-reserving for the NEW attempt.
      tx.update(orderRef, { paymentStatus: PAYMENT_STATUS.TIMEOUT, updatedAt: FieldValue.serverTimestamp() });
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
    const orderPatch = { activePaymentId: paymentRef.id, paymentStatus: PAYMENT_STATUS.PENDING, updatedAt: FieldValue.serverTimestamp() };
    if (restockPlan) {
      // Writes come AFTER every read above — required by Firestore transactions.
      for (const [pid, inv] of restockPlan.nextInventory) {
        const derived = deriveStock(inv);
        tx.update(adminDb.collection('products').doc(pid), {
          inventory: inv,
          stockQuantity: derived.stockQuantity,
          availableSizes: derived.availableSizes,
        });
      }
      for (const log of restockPlan.logs) {
        tx.set(adminDb.collection('inventoryLogs').doc(), {
          ...log,
          productName: restockPlan.byId.get(log.productId)?.name ?? null,
          createdAt: FieldValue.serverTimestamp(),
        });
      }
      orderPatch.inventoryReserved = true;
    }
    tx.update(orderRef, orderPatch);
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
    // ---- Lookup order: payments first, then tips. If neither knows this
    // checkout id the webhook is acknowledged with 200 "ignored" — a tip
    // callback must NEVER touch orders and vice versa.
    const paymentsSnap = await adminDb.collection('payments')
      .where('providerReference', '==', verified.providerReference)
      .limit(1)
      .get()
      .catch(() => null);
    let targetKind = paymentsSnap && !paymentsSnap.empty ? 'payment' : null;
    if (!targetKind) {
      const tipsMod = await import('./tips.js');
      const knownTip = await tipsMod.findTipByProviderReference(verified.providerReference).catch(() => null);
      if (knownTip) targetKind = 'tip';
    }

    let applied;
    if (targetKind === 'tip') {
      // Tips branch — same rules as payments, own transaction in tip-core.
      const tipsMod = await import('./tips.js');
      if (verified.status === PAYMENT_STATUS.PAID) {
        // NEVER trust the webhook alone for money: re-confirm with an
        // explicit status query on the SAME checkout id first.
        const provider = getMpesaProvider();
        const confirmation = await provider.checkStatus(verified.providerReference);
        if (confirmation.status !== PAYMENT_STATUS.PAID
          || String(confirmation.providerReference) !== String(verified.providerReference)) {
          console.error(`mpesa-callback: unconfirmed PAID tip for ${verified.providerReference} (provider says ${confirmation.status}) — acknowledged with 200`);
          return send({ ok: true, received: true, applied: false });
        }
        applied = await tipsMod.applyTipCallback({
          providerReference: verified.providerReference,
          status: PAYMENT_STATUS.PAID,
          amount: confirmation.amount ?? verified.amount,
          transactionReference: confirmation.transactionReference || verified.transactionReference,
          eventId: verified.eventId || `callback:${verified.providerReference}:PAID`,
          source: 'PRINTPAY',
          reason: confirmation.reason ?? verified.reason ?? null,
        });
      } else {
        applied = await tipsMod.applyTipCallback({
          providerReference: verified.providerReference,
          status: verified.status,
          amount: verified.amount,
          transactionReference: verified.transactionReference,
          eventId: verified.eventId || `callback:${verified.providerReference}:${verified.status}`,
          source: 'PRINTPAY',
          reason: verified.reason || null,
        });
      }
      return send({ ok: true, kind: 'tip', applied: applied?.applied !== false, duplicate: applied?.duplicate === true });
    }

    if (!targetKind) {
      console.error(`mpesa-callback: unknown checkout id ${verified.providerReference} (no payment, no tip) — acknowledged with 200 ignored`);
      return send({ ok: true, received: true, applied: false, ignored: true });
    }

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
