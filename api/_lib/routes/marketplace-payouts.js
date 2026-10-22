import { FieldValue } from 'firebase-admin/firestore';
import { adminDb, requireAdmin, requireUser } from '../firebase-admin.js';
import { clientError, methodNotAllowed } from '../http.js';
import { initiatePrintPayB2CPayout, getPrintPayB2CWalletBalance, initiatePrintPayB2CTopup, MIN_B2C_AMOUNT } from '../printpay-b2c.js';
import { sendTelegramMessage } from '../telegram.js';

const clean = (value, max = 180) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const money = value => Number.isSafeInteger(value) && value > 0 && value <= 10_000_000;
const PAYOUT_FEE_BUFFER = 50;
function alertPayoutAdmin(message) {
  Promise.resolve(sendTelegramMessage(message)).catch(error => console.error('[marketplace-payouts] Telegram payout alert failed:', error?.message || String(error)));
}
const RESERVED = new Set(['REQUESTED', 'PENDING', 'APPROVED', 'DISPATCHING', 'PROCESSING', 'PROVIDER_UNKNOWN']);
const REFUND_HOLD = new Set(['REQUESTED', 'APPROVED', 'CONFIRMED', 'PARTIALLY_REFUNDED']);
async function availableAfterRefundHolds(ledgerDocs, readOrder) {
  const rows = ledgerDocs.map(doc => ({ id: doc.id, data: doc.data() || {} }));
  const orderIds = [...new Set(rows.filter(row => row.data.balanceBucket === 'AVAILABLE' && row.data.orderDocumentId).map(row => row.data.orderDocumentId))];
  const orderStatuses = new Map();
  for (const orderId of orderIds) {
    // Older ledger rows can contain an order reference that is not a bare
    // Firestore document ID. Treat those rows as held rather than letting one
    // malformed reference crash the entire seller payout endpoint.
    if (typeof orderId !== 'string' || !orderId.trim() || orderId.includes('/')) {
      orderStatuses.set(orderId, { status: 'UNKNOWN', reconciliationStatus: 'REQUIRED', readFailed: true });
      continue;
    }
    try {
      const snap = await readOrder(orderId);
      const data = snap.exists ? snap.data() || {} : {};
      orderStatuses.set(orderId, {
        status: snap.exists ? String(data.refundStatus || (data.paymentStatus === 'REFUNDED' ? 'CONFIRMED' : 'NONE')).toUpperCase() : 'UNKNOWN',
        reconciliationStatus: String(data.marketplaceRefundReconciliationStatus || 'REQUIRED').toUpperCase(),
        readFailed: !snap.exists,
      });
    } catch (error) {
      console.error('[marketplace-payouts] Could not inspect order before releasing seller earnings; holding balance.', { orderId, message: error?.message || String(error) });
      orderStatuses.set(orderId, { status: 'UNKNOWN', reconciliationStatus: 'REQUIRED', readFailed: true });
    }
  }
  return rows.filter(row => {
    if (row.data.balanceBucket !== 'AVAILABLE') return false;
    if (!row.data.orderDocumentId) return true;
    const order = orderStatuses.get(row.data.orderDocumentId) || { status: 'UNKNOWN', reconciliationStatus: 'REQUIRED', readFailed: true };
    if (order.readFailed || order.status === 'UNKNOWN') return false;
    if (!REFUND_HOLD.has(order.status)) return true;
    return ['CONFIRMED', 'PARTIALLY_REFUNDED'].includes(order.status) && order.reconciliationStatus === 'RECONCILED';
  }).reduce((sum, row) => sum + Number(row.data.amount || 0), 0);
}

const toDate = value => {
  if (value?.toDate) return value.toDate();
  if (value instanceof Date) return value;
  if (typeof value === 'string' || typeof value === 'number') {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  return null;
};
const iso = value => toDate(value)?.toISOString?.() ?? null;
const timeValue = value => toDate(value)?.getTime?.() ?? 0;
const safePayout = (doc, includePayoutPhone = false) => {
  const d = doc.data() || {};
  return {
    id: doc.id, sellerId: d.sellerId, sellerName: d.sellerName || '', amount: d.amount, currency: d.currency || 'KES',
    status: ['PENDING', 'REQUESTED'].includes(String(d.status || 'REQUESTED').toUpperCase()) ? 'REQUESTED' : String(d.status || 'REQUESTED').toUpperCase(), reason: d.reason || d.reviewNote || '',
    reviewNote: d.reviewNote || '', providerReference: d.providerReference || '',
    requestedAt: iso(d.createdAt || d.requestedAt), approvedAt: iso(d.approvedAt), paidAt: iso(d.paidAt),
    rejectedAt: iso(d.rejectedAt), payoutPhoneMasked: d.payoutPhoneMasked || maskPhone(d.payoutPhone || ''),
    printPayProviderMessage: d.printPayProviderMessage || '', printPayFeeBreakdown: d.printPayFeeBreakdown || null,
    printPayDispatchError: d.printPayDispatchError || '',
    printPayProviderHttpStatus: Number.isInteger(d.printPayProviderHttpStatus) ? d.printPayProviderHttpStatus : null,
    printPayProviderRejectionMessage: d.printPayProviderRejectionMessage || '',
    ...(includePayoutPhone ? { payoutPhone: d.payoutPhone || '' } : {}),
  };
};
function normalizeKenyanPhone(value) {
  const digits = String(value || '').replace(/[\s()-]/g, '');
  if (/^07\d{8}$/.test(digits)) return '+254' + digits.slice(1);
  if (/^01\d{8}$/.test(digits)) return '+254' + digits.slice(1);
  if (/^254[17]\d{8}$/.test(digits)) return '+' + digits;
  if (/^\+254[17]\d{8}$/.test(digits)) return digits;
  throw clientError('Enter a valid Kenyan M-Pesa number.');
}
function maskPhone(phone) { return phone ? phone.slice(0, 7) + '•••' + phone.slice(-2) : ''; }

export async function sellerPayouts(req, res) {
  const user = await requireUser(req);
  const sellerRef = adminDb.collection('sellers').doc(user.uid);
  if (req.method === 'GET') {
    const [sellerSnap, ledgerSnap, payoutsSnap] = await Promise.all([
      sellerRef.get(),
      adminDb.collection('sellerLedger').where('sellerId', '==', user.uid).get(),
      adminDb.collection('sellerPayouts').where('sellerId', '==', user.uid).get(),
    ]);
    if (!sellerSnap.exists || (sellerSnap.data()?.ownerUid && sellerSnap.data()?.ownerUid !== user.uid) || sellerSnap.data()?.status !== 'ACTIVE') {
      throw clientError('An approved, active seller account is required.', 403);
    }
    const payouts = payoutsSnap.docs.map(safePayout);
    const available = await availableAfterRefundHolds(ledgerSnap.docs, orderId => adminDb.collection('orders').doc(orderId).get());
    const reserved = payoutsSnap.docs.filter(doc => RESERVED.has(String(doc.data()?.status || '').toUpperCase())).reduce((sum, doc) => sum + Number(doc.data()?.amount || 0), 0);
    return res.json({ currency: 'KES', availableBalance: Math.max(0, available - reserved), pendingBalance: ledgerSnap.docs.reduce((sum, doc) => { const row = doc.data() || {}; return String(row.balanceBucket || '').toUpperCase() === 'PENDING' ? sum + Number(row.amount || 0) : sum; }, 0), payouts });
  }
  if (req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);
  const sellerSnap = await sellerRef.get();
  if (!sellerSnap.exists || (sellerSnap.data()?.ownerUid && sellerSnap.data()?.ownerUid !== user.uid) || sellerSnap.data()?.status !== 'ACTIVE') {
    throw clientError('An approved, active seller account is required.', 403);
  }
  const amount = req.body?.amount;
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > 10_000_000) throw clientError('Payout amount must be a positive whole KSh amount.');
  if (amount < MIN_B2C_AMOUNT) throw clientError('The minimum payout is KSh 10.');
  const phone = normalizeKenyanPhone(req.body?.payoutPhone || sellerSnap.data()?.defaultPayoutPhone);
  const requestKey = clean(req.body?.idempotencyKey, 80);
  if (!/^[A-Za-z0-9_-]{12,80}$/.test(requestKey)) throw clientError('A valid unique payout request key is required.');
  const payoutRef = adminDb.collection('sellerPayouts').doc(user.uid + '_' + requestKey);
  const creation = await adminDb.runTransaction(async tx => {
    const [existing, ledgerSnap, payoutsSnap] = await Promise.all([
      tx.get(payoutRef),
      tx.get(adminDb.collection('sellerLedger').where('sellerId', '==', user.uid)),
      tx.get(adminDb.collection('sellerPayouts').where('sellerId', '==', user.uid)),
    ]);
    if (existing.exists) {
      const prior = existing.data();
      if (prior.sellerId !== user.uid || Number(prior.amount) !== amount || prior.payoutPhone !== phone) throw clientError('This payout request key was already used for different details.', 409);
      return { created: false, status: String(prior.status || 'REQUESTED').toUpperCase() };
    }
    const available = await availableAfterRefundHolds(ledgerSnap.docs, orderId => tx.get(adminDb.collection('orders').doc(orderId)));
    const reserved = payoutsSnap.docs.filter(doc => RESERVED.has(String(doc.data()?.status || '').toUpperCase())).reduce((sum, doc) => sum + Number(doc.data()?.amount || 0), 0);
    if (amount > available - reserved) throw clientError('Payout amount exceeds your available balance.', 409);
    tx.create(payoutRef, {
      sellerId: user.uid, sellerName: String(sellerSnap.data()?.businessName || sellerSnap.data()?.displayName || 'Marketplace seller').slice(0, 100),
      amount, currency: 'KES', status: 'DISPATCHING', payoutPhone: phone, payoutPhoneMasked: maskPhone(phone),
      idempotencyKey: payoutRef.id, printPayProvider: 'PRINTPAY', printPayDispatchStartedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(), createdAt: FieldValue.serverTimestamp(),
    });
    tx.set(adminDb.collection('auditLogs').doc(), { actorUid: user.uid, action: 'SELLER_PAYOUT_PRINTPAY_DISPATCH_STARTED', entityType: 'SELLER_PAYOUT', entityId: payoutRef.id, amount, createdAt: FieldValue.serverTimestamp() });
    return { created: true, status: 'DISPATCHING' };
  });

  // Exact retries return the existing payout and never dispatch a second transfer.
  if (!creation.created) {
    return res.status(200).json({
      ok: true, payoutId: payoutRef.id, status: creation.status,
      message: creation.status === 'PROCESSING'
        ? 'Your payout has been sent to PrintPay for processing. Do not submit it again.'
        : creation.status === 'PROVIDER_UNKNOWN'
          ? 'Your payout is being reconciled because PrintPay did not return a definite result. Do not submit it again.'
          : 'This payout request already exists.',
    });
  }

  let wallet;
  try {
    wallet = await getPrintPayB2CWalletBalance();
  } catch (error) {
    await payoutRef.update({ status: 'REQUESTED', printPayDispatchError: String(error?.message || 'Could not check PrintPay wallet balance.').slice(0, 300), updatedAt: FieldValue.serverTimestamp() });
    alertPayoutAdmin(`Payout waiting for wallet funds: ${String(sellerSnap.data()?.businessName || sellerSnap.data()?.displayName || 'Marketplace seller')} KSh ${amount} (wallet balance unavailable; check PrintPay).`);
    return res.status(202).json({ ok: true, payoutId: payoutRef.id, status: 'REQUESTED', message: 'Your payout request is received. It will be sent as soon as HerStep funds the payout wallet.' });
  }
  if (wallet.balance < amount + PAYOUT_FEE_BUFFER) {
    await payoutRef.update({ status: 'REQUESTED', printPayWalletBalanceAtRequest: wallet.balance, updatedAt: FieldValue.serverTimestamp() });
    alertPayoutAdmin(`Payout waiting for wallet funds: ${String(sellerSnap.data()?.businessName || sellerSnap.data()?.displayName || 'Marketplace seller')} KSh ${amount} (wallet KSh ${wallet.balance}).`);
    return res.status(202).json({ ok: true, payoutId: payoutRef.id, status: 'REQUESTED', message: 'Your payout request is received. It will be sent as soon as HerStep funds the payout wallet.' });
  }
  let result;
  try {
    result = await initiatePrintPayB2CPayout({ payoutId: payoutRef.id, phone, amount });
  } catch (error) {
    const unknown = Boolean(error?.outcomeUnknown);
    const status = unknown ? 'PROVIDER_UNKNOWN' : 'FAILED';
    await adminDb.runTransaction(async tx => {
      const snap = await tx.get(payoutRef);
      if (!snap.exists || snap.data()?.status !== 'DISPATCHING') return;
      const safeError = String(error?.message || 'PrintPay request failed').slice(0, 300);
      const providerMessage = clean(error?.providerMessage, 300);
      const providerHttpStatus = Number.isInteger(error?.providerHttpStatus) ? error.providerHttpStatus : null;
      tx.update(payoutRef, {
        status,
        printPayDispatchError: safeError,
        printPayProviderHttpStatus: providerHttpStatus,
        printPayProviderRejectionMessage: providerMessage,
        printPayDispatchOutcomeUnknown: unknown,
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.set(adminDb.collection('auditLogs').doc(), { actorUid: user.uid, action: unknown ? 'SELLER_PAYOUT_PRINTPAY_OUTCOME_UNKNOWN' : 'SELLER_PAYOUT_PRINTPAY_REJECTED', entityType: 'SELLER_PAYOUT', entityId: payoutRef.id, amount, error: safeError, providerHttpStatus, providerMessage, createdAt: FieldValue.serverTimestamp() });
    });
    if (unknown) {
      alertPayoutAdmin(`Seller payout outcome unknown: ${String(sellerSnap.data()?.businessName || sellerSnap.data()?.displayName || 'Marketplace seller')} KSh ${amount}. Reconcile with PrintPay before retrying.`);
      return res.status(202).json({ ok: true, payoutId: payoutRef.id, status, message: 'Your payout is being checked. Your balance remains reserved until the result is confirmed.' });
    }
    alertPayoutAdmin(`PrintPay rejected seller payout: ${String(sellerSnap.data()?.businessName || sellerSnap.data()?.displayName || 'Marketplace seller')} KSh ${amount}. PrintPay message: ${clean(error?.providerMessage || error?.message, 300) || 'No message returned'}`);
    return res.status(502).json({ ok: false, payoutId: payoutRef.id, status, message: 'We could not send your payout right now. Your balance is unchanged and the HerStep team has been notified.' });
  }

  // Provider success means initialized, not final delivery. Keep the payout reserved.
  try {
    await adminDb.runTransaction(async tx => {
      const snap = await tx.get(payoutRef);
      if (!snap.exists || snap.data()?.status !== 'DISPATCHING') throw clientError('Payout state changed during PrintPay dispatch; reconciliation is required.', 409);
      tx.update(payoutRef, {
        status: 'PROCESSING',
        printPayProviderStatus: result.providerStatus,
        printPayProviderMessage: result.providerMessage,
        printPayFinalStatusVerified: false,
        printPayFeeBreakdown: result.feeBreakdown,
        printPayInitiatedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      tx.set(adminDb.collection('auditLogs').doc(), { actorUid: user.uid, action: 'SELLER_PAYOUT_PRINTPAY_INITIALIZED', entityType: 'SELLER_PAYOUT', entityId: payoutRef.id, amount, feeBreakdown: result.feeBreakdown, providerMessage: result.providerMessage, createdAt: FieldValue.serverTimestamp() });
    });
  } catch (persistError) {
    console.error('[marketplace-payouts] PrintPay accepted seller payout but status persistence failed; do not resend.', { payoutId: payoutRef.id, message: persistError?.message || String(persistError) });
    try {
      await payoutRef.update({ status: 'PROVIDER_UNKNOWN', printPayProvider: 'PRINTPAY', printPayProviderStatus: result.providerStatus, printPayProviderMessage: result.providerMessage, printPayFinalStatusVerified: false, printPayFeeBreakdown: result.feeBreakdown, printPayDispatchError: 'PrintPay accepted the request, but saving its status failed. Reconcile before any retry.', updatedAt: FieldValue.serverTimestamp() });
    } catch (lockError) {
      console.error('[marketplace-payouts] CRITICAL: unable to persist unknown seller payout outcome; do not resend.', { payoutId: payoutRef.id, message: lockError?.message || String(lockError) });
    }
    return res.status(202).json({ ok: true, payoutId: payoutRef.id, status: 'PROVIDER_UNKNOWN', message: 'PrintPay accepted the payout request, but the app could not save its final state. It is held for reconciliation; do not submit again.' });
  }
  return res.status(201).json({
    ok: true, payoutId: payoutRef.id, status: 'PROCESSING',
    message: 'Your payout was sent to PrintPay automatically and is processing. Final delivery will be confirmed before it is marked paid.',
  });
}

export async function adminMarketplacePayouts(req, res) {
  const admin = await requireAdmin(req);
  if (req.method === 'GET') {
    const [payoutSnapshot, refundSnap] = await Promise.all([
      // Read all recent records without filtering by status. Legacy requests may
      // use PENDING/lowercase statuses or omit status; filtering only modern
      // uppercase values made real seller requests disappear from the admin UI.
      // Avoid orderBy(createdAt) too, since it excludes records missing timestamps.
      adminDb.collection('sellerPayouts').get(),
      adminDb.collection('refundRecords').where('status', '==', 'CONFIRMED').limit(200).get().catch(() => ({ docs: [] })),
    ]);
    const payoutDocs = payoutSnapshot.docs
      .sort((a, b) => timeValue(b.data()?.createdAt || b.data()?.requestedAt) - timeValue(a.data()?.createdAt || a.data()?.requestedAt));
    const refundsToReconcile = [];
    for (const doc of refundSnap.docs) {
      const refund = doc.data() || {};
      if (refund.type !== 'REFUND' || refund.marketplaceReconciledAt || !refund.orderDocumentId) continue;
      const orderSnap = await adminDb.collection('orders').doc(refund.orderDocumentId).get();
      if (!orderSnap.exists) continue;
      const order = orderSnap.data() || {};
      const sellerLines = (Array.isArray(order.items) ? order.items : []).map((item, index) => ({
        itemIndex: index,
        sellerId: String(item.sellerId || item.sellerSnapshot?.sellerId || ''),
        sellerName: String(item.sellerSnapshot?.displayName || item.sellerSnapshot?.businessName || 'Marketplace seller'),
        productName: String(item.name || 'Marketplace item'),
        lineTotal: Number(item.lineTotal ?? (Number(item.unitPrice) * Number(item.quantity))) || 0,
      })).filter(item => item.sellerId && item.lineTotal > 0);
      if (sellerLines.length) refundsToReconcile.push({
        id: doc.id, orderDocumentId: refund.orderDocumentId, orderId: refund.orderId || order.orderId || refund.orderDocumentId,
        amount: Number(refund.amount) || 0, currency: refund.currency || 'KES', reason: refund.reason || '',
        providerReference: refund.providerReference || '', confirmedAt: iso(refund.confirmedAt), sellerLines,
      });
    }
    return res.json({ payouts: payoutDocs.map(doc => safePayout(doc, true)), refundsToReconcile });
  }
  if (req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);
  const action = clean(req.body?.action, 30).toUpperCase();
  const payoutId = clean(req.body?.payoutId, 180);
  const suppliedReason = clean(req.body?.reason, 500);
  const reason = suppliedReason || (action === 'APPROVE' ? 'Approved by admin' : action === 'REJECT' ? 'Rejected by admin' : '');
  if (!payoutId && !['RECONCILE_REFUND', 'PRINTPAY_BALANCE', 'PRINTPAY_TOPUP'].includes(action)) throw clientError('Payout request ID is required.');
  const ref = payoutId ? adminDb.collection('sellerPayouts').doc(payoutId) : null;
  if (action === 'APPROVE' || action === 'REJECT') {
    await adminDb.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw clientError('Payout request not found.', 404);
      const payout = snap.data();
      if (!['REQUESTED', 'PENDING'].includes(String(payout.status || 'REQUESTED').toUpperCase())) throw clientError('Only requested payouts can be approved or rejected.', 409);
      const status = action === 'APPROVE' ? 'APPROVED' : 'REJECTED';
      tx.update(ref, { status, reviewNote: reason, ...(action === 'APPROVE' ? { approvedBy: admin.uid, approvedAt: FieldValue.serverTimestamp() } : { rejectedBy: admin.uid, rejectedAt: FieldValue.serverTimestamp() }), updatedAt: FieldValue.serverTimestamp() });
      tx.set(adminDb.collection('auditLogs').doc(), { actorUid: admin.uid, action: 'SELLER_PAYOUT_' + status, entityType: 'SELLER_PAYOUT', entityId: payoutId, amount: payout.amount, reason, createdAt: FieldValue.serverTimestamp() });
    });
    return res.json({ ok: true, status: action === 'APPROVE' ? 'APPROVED' : 'REJECTED', message: action === 'APPROVE' ? 'Payout approved. Send funds separately, then record the confirmed provider reference.' : 'Payout request rejected.' });
  }
  if (action === 'PRINTPAY_BALANCE') {
    try {
      const balance = await getPrintPayB2CWalletBalance();
      return res.json({ ok: true, ...balance });
    } catch (error) { error.expose = true; error.statusCode = error.statusCode || 502; throw error; }
  }
  if (action === 'PRINTPAY_TOPUP') {
    const phone = normalizeKenyanPhone(req.body?.phone);
    const amount = req.body?.amount;
    if (!money(amount)) throw clientError('Top up amount must be a positive whole KSh amount.');
    try {
      const result = await initiatePrintPayB2CTopup({ phone, amount });
      await adminDb.collection('auditLogs').add({ actorUid: admin.uid, action: 'PRINTPAY_STK_TOPUP_INITIALIZED', entityType: 'PRINTPAY_TOPUP', phoneMasked: maskPhone(phone), amount, providerMessage: result.providerMessage, createdAt: FieldValue.serverTimestamp() });
      return res.json({ ok: true, status: result.providerStatus, message: result.providerMessage });
    } catch (error) {
      const providerMessage = clean(error?.providerMessage || error?.message, 300);
      await adminDb.collection('auditLogs').add({ actorUid: admin.uid, action: 'PRINTPAY_STK_TOPUP_REJECTED', entityType: 'PRINTPAY_TOPUP', phoneMasked: maskPhone(phone), amount, providerHttpStatus: Number.isInteger(error?.providerHttpStatus) ? error.providerHttpStatus : null, providerMessage, createdAt: FieldValue.serverTimestamp() });
      error.expose = true;
      error.statusCode = 502;
      error.message = 'PrintPay STK Push failed: ' + providerMessage;
      throw error;
    }
  }
  if (action === 'SEND_PRINTPAY') {
    // Claim the request transactionally before contacting PrintPay. This makes
    // double-clicks and concurrent admin requests unable to dispatch twice.
    const claimed = await adminDb.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw clientError('Payout request not found.', 404);
      const payout = snap.data() || {};
      if (!['APPROVED', 'REQUESTED', 'FAILED'].includes(String(payout.status || '').toUpperCase())) throw clientError('Only approved, requested, or failed payouts can be sent with PrintPay.', 409);
      if (!Number.isSafeInteger(Number(payout.amount)) || Number(payout.amount) < MIN_B2C_AMOUNT) throw clientError('The minimum payout is KSh 10.');
      if (!payout.payoutPhone) throw clientError('This payout has no saved M-Pesa destination.', 409);
      tx.update(ref, { status: 'DISPATCHING', printPayDispatchStartedAt: FieldValue.serverTimestamp(), printPayDispatchStartedBy: admin.uid, updatedAt: FieldValue.serverTimestamp() });
      tx.set(adminDb.collection('auditLogs').doc(), { actorUid: admin.uid, action: 'SELLER_PAYOUT_PRINTPAY_DISPATCH_STARTED', entityType: 'SELLER_PAYOUT', entityId: payoutId, amount: payout.amount, createdAt: FieldValue.serverTimestamp() });
      return { phone: payout.payoutPhone, amount: Number(payout.amount), sellerId: payout.sellerId, sellerName: payout.sellerName || 'Marketplace seller' };
    });
    let result;
    try {
      const wallet = await getPrintPayB2CWalletBalance();
      if (wallet.balance < claimed.amount + PAYOUT_FEE_BUFFER) {
        await ref.update({ status: 'REQUESTED', printPayWalletBalanceAtRequest: wallet.balance, updatedAt: FieldValue.serverTimestamp() });
        alertPayoutAdmin(`Payout waiting for wallet funds: ${claimed.sellerName} KSh ${claimed.amount} (wallet KSh ${wallet.balance}).`);
        return res.status(202).json({ ok: true, status: 'REQUESTED', message: 'Wallet funds are not sufficient yet. This payout remains requested and reserved.' });
      }
      result = await initiatePrintPayB2CPayout({ payoutId, phone: claimed.phone, amount: claimed.amount });
    } catch (error) {
      const unknown = Boolean(error?.outcomeUnknown);
      await adminDb.runTransaction(async tx => {
        const snap = await tx.get(ref);
        if (!snap.exists || snap.data()?.status !== 'DISPATCHING') return;
        tx.update(ref, {
          status: unknown ? 'PROVIDER_UNKNOWN' : 'FAILED',
          printPayDispatchError: String(error?.message || 'PrintPay request failed').slice(0, 300),
          printPayProviderRejectionMessage: clean(error?.providerMessage, 300),
          printPayProviderHttpStatus: Number.isInteger(error?.providerHttpStatus) ? error.providerHttpStatus : null,
          printPayDispatchOutcomeUnknown: unknown,
          updatedAt: FieldValue.serverTimestamp(),
        });
        tx.set(adminDb.collection('auditLogs').doc(), { actorUid: admin.uid, action: unknown ? 'SELLER_PAYOUT_PRINTPAY_OUTCOME_UNKNOWN' : 'SELLER_PAYOUT_PRINTPAY_REJECTED', entityType: 'SELLER_PAYOUT', entityId: payoutId, amount: claimed.amount, error: String(error?.message || 'PrintPay request failed').slice(0, 300), createdAt: FieldValue.serverTimestamp() });
      });
      if (unknown) throw clientError('PrintPay outcome is unknown. This payout is locked against resending; check the PrintPay dashboard and reconcile it before taking further action.', 409);
      alertPayoutAdmin(`PrintPay rejected seller payout: ${claimed.sellerName} KSh ${claimed.amount}. PrintPay message: ${clean(error?.providerMessage || error?.message, 300) || 'No message returned'}`);
      error.expose = true;
      error.statusCode = 502;
      throw error;
    }
    // From this point PrintPay has accepted the request. If Firestore persistence
    // fails, never reopen the request for dispatch: retain the lock if possible.
    try {
      await adminDb.runTransaction(async tx => {
        const snap = await tx.get(ref);
        if (!snap.exists || snap.data()?.status !== 'DISPATCHING') throw clientError('Payout dispatch state changed; manual reconciliation is required.', 409);
        tx.update(ref, {
          status: 'PROCESSING',
          printPayProvider: 'PRINTPAY',
          printPayProviderStatus: result.providerStatus,
          printPayProviderMessage: result.providerMessage,
          printPayFinalStatusVerified: false,
          printPayFeeBreakdown: result.feeBreakdown,
          printPayInitiatedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        tx.set(adminDb.collection('auditLogs').doc(), { actorUid: admin.uid, action: 'SELLER_PAYOUT_PRINTPAY_INITIALIZED', entityType: 'SELLER_PAYOUT', entityId: payoutId, amount: claimed.amount, feeBreakdown: result.feeBreakdown, providerMessage: result.providerMessage, createdAt: FieldValue.serverTimestamp() });
      });
    } catch (persistError) {
      console.error('[marketplace-payouts] PrintPay accepted payout but processing status could not be saved; payout must not be resent.', { payoutId, message: persistError?.message || String(persistError) });
      try {
        await ref.update({ status: 'PROVIDER_UNKNOWN', printPayProvider: 'PRINTPAY', printPayProviderStatus: result.providerStatus, printPayProviderMessage: result.providerMessage, printPayFinalStatusVerified: false, printPayFeeBreakdown: result.feeBreakdown, printPayDispatchError: 'PrintPay accepted the request, but saving its status failed. Reconcile before any retry.', updatedAt: FieldValue.serverTimestamp() });
      } catch (lockError) {
        console.error('[marketplace-payouts] CRITICAL: unable to persist unknown PrintPay outcome; do not resend.', { payoutId, message: lockError?.message || String(lockError) });
      }
      throw clientError('PrintPay accepted the payout request, but the app could not save its status. Check PrintPay and reconcile before taking any further action.', 409);
    }
    return res.json({ ok: true, status: 'PROCESSING', feeBreakdown: result.feeBreakdown, message: 'PrintPay accepted the payout request for processing. Final delivery is not yet verified; do not resend this payout.' });
  }
  if (action === 'MARK_PAID') {
    const providerReference = clean(req.body?.providerReference, 160);
    if (!providerReference) throw clientError('A confirmed M-Pesa/provider reference is required.');
    await adminDb.runTransaction(async tx => {
      const [snap, debitSnap] = await Promise.all([
        tx.get(ref),
        tx.get(adminDb.collection('sellerLedger').doc(Buffer.from('marketplace-payout:' + payoutId).toString('base64url'))),
      ]);
      if (!snap.exists) throw clientError('Payout request not found.', 404);
      const payout = snap.data();
      if (!['APPROVED', 'PROCESSING', 'PROVIDER_UNKNOWN'].includes(String(payout.status || '').toUpperCase())) throw clientError('Only an approved or PrintPay-dispatched payout with a confirmed provider reference can be marked paid.', 409);
      if (debitSnap.exists) throw clientError('A payout ledger debit already exists.', 409);
      const ledgerRef = adminDb.collection('sellerLedger').doc(Buffer.from('marketplace-payout:' + payoutId).toString('base64url'));
      const fee = Number.isSafeInteger(payout.printPayFeeBreakdown?.fee) && payout.printPayFeeBreakdown.fee >= 0 ? payout.printPayFeeBreakdown.fee : 0;
      const totalDebit = Number(payout.amount) + fee;
      tx.set(ledgerRef, { sellerId: payout.sellerId, type: 'SELLER_PAYOUT', status: 'POSTED', amount: -totalDebit, transferAmount: Number(payout.amount), providerFee: fee, totalDebit, currency: payout.currency || 'KES', balanceBucket: 'AVAILABLE', payoutId, providerReference, idempotencyKey: ledgerRef.id, createdAt: FieldValue.serverTimestamp() });
      tx.update(ref, { status: 'PAID', providerReference, paidBy: admin.uid, paidAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      tx.set(adminDb.collection('auditLogs').doc(), { actorUid: admin.uid, action: 'SELLER_PAYOUT_PAID', entityType: 'SELLER_PAYOUT', entityId: payoutId, amount: payout.amount, providerReference, createdAt: FieldValue.serverTimestamp() });
    });
    return res.json({ ok: true, status: 'PAID', message: 'Payout recorded as paid with an immutable seller-ledger debit.' });
  }
  if (action === 'RECONCILE_REFUND') {
    const refundRecordId = clean(req.body?.refundRecordId, 120);
    const allocations = req.body?.allocations;
    const reason = clean(req.body?.reason, 500);
    if (!/^[A-Za-z0-9_-]{1,120}$/.test(refundRecordId) || !Array.isArray(allocations) || allocations.length > 20) throw clientError('Choose a confirmed refund and provide valid seller allocations.');
    if (!reason) throw clientError('A reconciliation note is required.');
    const normalized = allocations.map(row => ({ sellerId: clean(row?.sellerId, 128), amount: row?.amount }));
    // Do not let an empty/all-zero allocation set mark a refund reconciled:
    // that would release every seller's refund hold without adjusting earnings.
    if (!normalized.length || normalized.some(row => !row.sellerId || !money(row.amount)) || new Set(normalized.map(row => row.sellerId)).size !== normalized.length) {
      throw clientError('Allocate a positive whole-KSh amount to at least one unique seller before reconciling this refund.');
    }
    const refundRef = adminDb.collection('refundRecords').doc(refundRecordId);
    const result = await adminDb.runTransaction(async tx => {
      const refundSnap = await tx.get(refundRef);
      if (!refundSnap.exists) throw clientError('Refund record not found.', 404);
      const refund = refundSnap.data() || {};
      if (refund.type !== 'REFUND' || refund.status !== 'CONFIRMED' || !refund.orderDocumentId) throw clientError('Only a confirmed refund can be reconciled.', 409);
      if (refund.marketplaceReconciledAt) throw clientError('This refund has already been reconciled.', 409);
      const orderRef = adminDb.collection('orders').doc(refund.orderDocumentId);
      const [orderSnap, ledgerSnap, orderRefunds] = await Promise.all([
        tx.get(orderRef),
        tx.get(adminDb.collection('sellerLedger').where('orderDocumentId', '==', refund.orderDocumentId)),
        tx.get(adminDb.collection('refundRecords').where('orderDocumentId', '==', refund.orderDocumentId)),
      ]);
      if (!orderSnap.exists) throw clientError('Refund order not found.', 404);
      const order = orderSnap.data() || {};
      const allocationTotal = normalized.reduce((sum, row) => sum + row.amount, 0);
      const orderItems = Array.isArray(order.items) ? order.items : [];
      const marketplaceOnlyOrder = orderItems.length > 0 && orderItems.every(item => Boolean(item?.sellerId || item?.sellerSnapshot?.sellerId));
      if (allocationTotal > Number(refund.amount || 0)) throw clientError('Seller allocations cannot exceed the confirmed refund amount.', 409);
      // Marketplace-only refunds must be fully allocated across their sellers.
      // Otherwise a partial ledger debit could incorrectly release the entire
      // order's refund hold and make the unadjusted balance withdrawable.
      if (marketplaceOnlyOrder && allocationTotal !== Number(refund.amount || 0)) {
        throw clientError('For a marketplace-only order, seller allocations must equal the confirmed refund amount.', 409);
      }
      const ledger = ledgerSnap.docs.map(doc => ({ id: doc.id, data: doc.data() || {} }));
      const writes = [];
      for (const allocation of normalized) {
        const sellerRows = ledger.filter(row => row.data.sellerId === allocation.sellerId);
        const originalGross = sellerRows.filter(row => row.data.type === 'ORDER_PAYMENT_PENDING' && row.data.orderDocumentId === refund.orderDocumentId)
          .reduce((sum, row) => sum + Math.max(0, Number(row.data.amount) || 0), 0);
        if (originalGross <= 0) throw clientError('A selected seller has no marketplace earnings on this order.', 409);
        const priorRefunds = sellerRows.filter(row => row.data.type === 'MARKETPLACE_REFUND_ADJUSTMENT' && row.data.orderDocumentId === refund.orderDocumentId)
          .reduce((sum, row) => sum + Math.abs(Number(row.data.amount) || 0), 0);
        if (allocation.amount > originalGross - priorRefunds) throw clientError('Seller refund allocation exceeds that seller’s remaining marketplace earnings.', 409);
        const orderRows = sellerRows.filter(row => row.data.orderDocumentId === refund.orderDocumentId);
        const pending = orderRows.filter(row => row.data.balanceBucket === 'PENDING').reduce((sum, row) => sum + Number(row.data.amount || 0), 0);
        const pendingDebit = Math.min(allocation.amount, Math.max(0, pending));
        const availableDebit = allocation.amount - pendingDebit;
        const base = Buffer.from('marketplace-refund:' + refundRecordId + ':' + allocation.sellerId).toString('base64url');
        const common = {
          sellerId: allocation.sellerId, orderDocumentId: refund.orderDocumentId, orderId: refund.orderId || order.orderId || refund.orderDocumentId,
          refundRecordId, type: 'MARKETPLACE_REFUND_ADJUSTMENT', status: 'POSTED', currency: refund.currency || 'KES',
          sourceProviderReference: refund.providerReference || '', reason, actorUid: admin.uid, idempotencyKey: base,
          createdAt: FieldValue.serverTimestamp(),
        };
        if (pendingDebit > 0) writes.push({ id: base + '_pending', data: { ...common, amount: -pendingDebit, balanceBucket: 'PENDING' } });
        if (availableDebit > 0) writes.push({ id: base + '_available', data: { ...common, amount: -availableDebit, balanceBucket: 'AVAILABLE' } });
      }
      const refs = writes.map(row => adminDb.collection('sellerLedger').doc(row.id));
      const existing = refs.length ? await tx.getAll(...refs) : [];
      if (existing.some(snap => snap.exists)) throw clientError('Refund adjustment entries already exist; review the ledger before retrying.', 409);
      for (let i = 0; i < writes.length; i++) tx.create(refs[i], writes[i].data);
      const now = FieldValue.serverTimestamp();
      tx.update(refundRef, {
        marketplaceReconciledAt: now, marketplaceReconciledBy: admin.uid, marketplaceReconciliationReason: reason,
        marketplaceAllocations: normalized, marketplaceAllocatedAmount: allocationTotal, updatedAt: now,
      });
      const unresolved = orderRefunds.docs.some(doc => {
        if (doc.id === refundRecordId) return false;
        const row = doc.data() || {};
        return row.type === 'REFUND' && (['REQUESTED', 'APPROVED'].includes(row.status) || (row.status === 'CONFIRMED' && !row.marketplaceReconciledAt));
      });
      tx.update(orderRef, { marketplaceRefundReconciliationStatus: unresolved ? 'REQUIRED' : 'RECONCILED', marketplaceRefundReconciledAt: unresolved ? null : now, updatedAt: now });
      tx.set(adminDb.collection('auditLogs').doc(), {
        actorUid: admin.uid, action: 'MARKETPLACE_REFUND_RECONCILED', entityType: 'REFUND', entityId: refundRecordId,
        orderDocumentId: refund.orderDocumentId, amount: allocationTotal, reason, allocations: normalized, createdAt: now,
      });
      return { allocationTotal, entriesCreated: writes.length, unresolved };
    });
    return res.json({ ok: true, status: result.unresolved ? 'RECONCILED_WITH_HOLDS' : 'RECONCILED', ...result,
      message: result.unresolved ? 'Seller adjustments recorded. Other open refunds still hold this order’s available earnings.' : 'Seller adjustments recorded and this order’s refund hold is released.' });
  }
  throw clientError('Choose APPROVE, REJECT, SEND_PRINTPAY, PRINTPAY_BALANCE, PRINTPAY_TOPUP, MARK_PAID, or RECONCILE_REFUND.');
}
