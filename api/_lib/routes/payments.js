// Payment routes (dispatched from api/payments.js):
//   POST /api/payments/stk/initiate  — create or reuse a PENDING payment in a
//          Firestore transaction, then (OUTSIDE the transaction) send ONE
//          PrintPay STK push. A payment that already has a providerReference
//          never receives a second push.
//   GET  /api/payments/status        — owner only; when the payment is still
//          PENDING and has a providerReference we poll the provider and apply
//          any confirmed result through applyVerifiedCallbackCore.
//   POST /api/payments/mpesa/callback— public webhook. verifyCallback() is
//          only a hint: PAID must be RE-CONFIRMED with checkStatus() before
//          anything is applied. Idempotent via paymentTransactions/{eventId}.
//   GET  /api/payments/receipt       — owner only, PAID only.
import { FieldValue } from 'firebase-admin/firestore';
import { adminDb, requireUser } from '../firebase-admin.js';
import { getMpesaProvider } from '../mpesa-provider.js';
import { clientError, methodNotAllowed } from '../http.js';
import {
  PAYMENT_STATUS,
  applyVerifiedCallbackCore,
  publicPayment,
} from '../order-core.js';

const ATTEMPT_WINDOW_MS = 30 * 60_000; // a dead attempt may be replaced after 30 min

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
      const fresh = Date.now() - initiatedAtMs < ATTEMPT_WINDOW_MS;
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
      // Stale attempt (>30 min): abandon it so a new one can start.
      tx.update(existing.ref, { status: PAYMENT_STATUS.TIMEOUT, failureReason: 'Attempt expired after 30 minutes', completedAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
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

  // Still PENDING with a live STK push? Ask the provider and apply the truth.
  if (data.status === PAYMENT_STATUS.PENDING && data.providerReference) {
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
        });
        const refreshed = await paymentRef.get();
        if (refreshed.exists) data = refreshed.data();
      }
    } catch (error) {
      // A provider hiccup must never break polling — the webhook will land
      // the real result. Log and return the current state.
      console.error(`payments.status poll failed for ${paymentId}:`, error?.message || error);
    }
  }

  return res.json({ payment: shape(paymentId, data) });
}

export async function mpesaCallback(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
  const provider = getMpesaProvider();
  const verified = await provider.verifyCallback(req);
  if (!verified?.providerReference) {
    return res.status(400).json({ ok: false, error: 'Unrecognised callback payload.' });
  }

  let applied;
  if (verified.status === PAYMENT_STATUS.PAID) {
    // NEVER trust the webhook alone: re-confirm with an explicit status query
    // and require the SAME checkout id before marking anything PAID.
    const confirmation = await provider.checkStatus(verified.providerReference);
    if (confirmation.status !== PAYMENT_STATUS.PAID
      || String(confirmation.providerReference) !== String(verified.providerReference)) {
      console.error(`mpesa-callback: unconfirmed PAID for ${verified.providerReference} (provider says ${confirmation.status})`);
      throw clientError('Payment could not be confirmed with the provider.', 409);
    }
    applied = await applyVerifiedCallbackCore(adminDb, { serverTimestamp: () => FieldValue.serverTimestamp() }, {
      providerReference: verified.providerReference,
      status: PAYMENT_STATUS.PAID,
      amount: confirmation.amount ?? verified.amount,
      transactionReference: confirmation.transactionReference || verified.transactionReference,
      eventId: verified.eventId || `callback:${verified.providerReference}:PAID`,
      source: 'PRINTPAY',
    });
  } else {
    applied = await applyVerifiedCallbackCore(adminDb, { serverTimestamp: () => FieldValue.serverTimestamp() }, {
      providerReference: verified.providerReference,
      status: verified.status,
      amount: verified.amount,
      transactionReference: verified.transactionReference,
      eventId: verified.eventId || `callback:${verified.providerReference}:${verified.status}`,
      source: 'PRINTPAY',
    });
  }

  return res.status(200).json({ ok: true, duplicate: applied.duplicate === true });
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
