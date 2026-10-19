import { FieldValue } from 'firebase-admin/firestore';
import { adminDb, requireAdmin, requireUser } from '../firebase-admin.js';
import { clientError, methodNotAllowed } from '../http.js';

const clean = (value, max = 180) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const money = value => Number.isSafeInteger(value) && value > 0 && value <= 10_000_000;
const RESERVED = new Set(['REQUESTED', 'APPROVED']);
const REFUND_HOLD = new Set(['REQUESTED', 'APPROVED', 'CONFIRMED', 'PARTIALLY_REFUNDED']);
async function availableAfterRefundHolds(ledgerDocs, readOrder) {
  const rows = ledgerDocs.map(doc => ({ id: doc.id, data: doc.data() || {} }));
  const orderIds = [...new Set(rows.filter(row => row.data.balanceBucket === 'AVAILABLE' && row.data.orderDocumentId).map(row => row.data.orderDocumentId))];
  const orderStatuses = new Map();
  for (const orderId of orderIds) {
    const snap = await readOrder(orderId);
    const data = snap.exists ? snap.data() || {} : {};
    orderStatuses.set(orderId, {
      status: snap.exists ? String(data.refundStatus || (data.paymentStatus === 'REFUNDED' ? 'CONFIRMED' : 'NONE')).toUpperCase() : 'UNKNOWN',
      reconciliationStatus: String(data.marketplaceRefundReconciliationStatus || 'REQUIRED').toUpperCase(),
    });
  }
  return rows.filter(row => {
    if (row.data.balanceBucket !== 'AVAILABLE') return false;
    if (!row.data.orderDocumentId) return true;
    const order = orderStatuses.get(row.data.orderDocumentId) || { status: 'UNKNOWN', reconciliationStatus: 'REQUIRED' };
    if (!REFUND_HOLD.has(order.status)) return true;
    return ['CONFIRMED', 'PARTIALLY_REFUNDED'].includes(order.status) && order.reconciliationStatus === 'RECONCILED';
  }).reduce((sum, row) => sum + Number(row.data.amount || 0), 0);
}

const iso = value => value?.toDate?.().toISOString?.() ?? null;
const safePayout = doc => {
  const d = doc.data() || {};
  return {
    id: doc.id, sellerId: d.sellerId, sellerName: d.sellerName || '', amount: d.amount, currency: d.currency || 'KES',
    status: d.status, reason: d.reason || '', providerReference: d.providerReference || '',
    requestedAt: iso(d.createdAt), approvedAt: iso(d.approvedAt), paidAt: iso(d.paidAt),
    rejectedAt: iso(d.rejectedAt), payoutPhoneMasked: d.payoutPhoneMasked || '',
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
    if (!sellerSnap.exists || sellerSnap.data()?.ownerUid !== user.uid || sellerSnap.data()?.status !== 'ACTIVE') {
      throw clientError('An approved, active seller account is required.', 403);
    }
    const payouts = payoutsSnap.docs.map(safePayout);
    const available = await availableAfterRefundHolds(ledgerSnap.docs, orderId => adminDb.collection('orders').doc(orderId).get());
    const reserved = payoutsSnap.docs.filter(doc => RESERVED.has(doc.data()?.status)).reduce((sum, doc) => sum + Number(doc.data()?.amount || 0), 0);
    return res.json({ currency: 'KES', availableBalance: Math.max(0, available - reserved), pendingBalance: ledgerSnap.docs.reduce((sum, doc) => { const row = doc.data() || {}; return row.balanceBucket === 'PENDING' ? sum + Number(row.amount || 0) : sum; }, 0), payouts });
  }
  if (req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);
  const sellerSnap = await sellerRef.get();
  if (!sellerSnap.exists || sellerSnap.data()?.ownerUid !== user.uid || sellerSnap.data()?.status !== 'ACTIVE') {
    throw clientError('An approved, active seller account is required.', 403);
  }
  const amount = req.body?.amount;
  const phone = normalizeKenyanPhone(req.body?.payoutPhone || sellerSnap.data()?.defaultPayoutPhone);
  const requestKey = clean(req.body?.idempotencyKey, 80);
  if (!money(amount)) throw clientError('Payout amount must be a positive whole KSh amount.');
  if (!/^[A-Za-z0-9_-]{12,80}$/.test(requestKey)) throw clientError('A valid unique payout request key is required.');
  const payoutRef = adminDb.collection('sellerPayouts').doc(user.uid + '_' + requestKey);
  await adminDb.runTransaction(async tx => {
    const [existing, ledgerSnap, payoutsSnap] = await Promise.all([
      tx.get(payoutRef),
      tx.get(adminDb.collection('sellerLedger').where('sellerId', '==', user.uid)),
      tx.get(adminDb.collection('sellerPayouts').where('sellerId', '==', user.uid)),
    ]);
    if (existing.exists) {
      const prior = existing.data();
      if (prior.sellerId !== user.uid || Number(prior.amount) !== amount || prior.payoutPhone !== phone) throw clientError('This payout request key was already used for different details.', 409);
      return; // exact idempotent retry
    }
    const available = await availableAfterRefundHolds(ledgerSnap.docs, orderId => tx.get(adminDb.collection('orders').doc(orderId)));
    const reserved = payoutsSnap.docs.filter(doc => RESERVED.has(doc.data()?.status)).reduce((sum, doc) => sum + Number(doc.data()?.amount || 0), 0);
    if (amount > available - reserved) throw clientError('Payout amount exceeds your available balance.', 409);
    tx.create(payoutRef, {
      sellerId: user.uid, sellerName: String(sellerSnap.data()?.businessName || sellerSnap.data()?.displayName || 'Marketplace seller').slice(0, 100),
      amount, currency: 'KES', status: 'REQUESTED', payoutPhone: phone, payoutPhoneMasked: maskPhone(phone),
      idempotencyKey: payoutRef.id, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
    });
    tx.set(adminDb.collection('auditLogs').doc(), { actorUid: user.uid, action: 'SELLER_PAYOUT_REQUESTED', entityType: 'SELLER_PAYOUT', entityId: payoutRef.id, amount, createdAt: FieldValue.serverTimestamp() });
  });
  return res.status(201).json({ ok: true, payoutId: payoutRef.id, status: 'REQUESTED', message: 'Payout request submitted for admin review. No money has been sent.' });
}

export async function adminMarketplacePayouts(req, res) {
  const admin = await requireAdmin(req);
  if (req.method === 'GET') {
    const [payoutSnap, refundSnap] = await Promise.all([
      adminDb.collection('sellerPayouts').orderBy('createdAt', 'desc').limit(200).get(),
      adminDb.collection('refundRecords').where('status', '==', 'CONFIRMED').limit(200).get().catch(() => ({ docs: [] })),
    ]);
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
    return res.json({ payouts: payoutSnap.docs.map(safePayout), refundsToReconcile });
  }
  if (req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);
  const action = clean(req.body?.action, 30).toUpperCase();
  const payoutId = clean(req.body?.payoutId, 180);
  const reason = clean(req.body?.reason, 500);
  if (!payoutId && action !== 'RECONCILE_REFUND') throw clientError('Payout request ID is required.');
  if (['REJECT', 'APPROVE'].includes(action) && !reason) throw clientError('A reason or review note is required.');
  const ref = payoutId ? adminDb.collection('sellerPayouts').doc(payoutId) : null;
  if (action === 'APPROVE' || action === 'REJECT') {
    await adminDb.runTransaction(async tx => {
      const snap = await tx.get(ref);
      if (!snap.exists) throw clientError('Payout request not found.', 404);
      const payout = snap.data();
      if (payout.status !== 'REQUESTED') throw clientError('Only requested payouts can be approved or rejected.', 409);
      const status = action === 'APPROVE' ? 'APPROVED' : 'REJECTED';
      tx.update(ref, { status, reviewNote: reason, ...(action === 'APPROVE' ? { approvedBy: admin.uid, approvedAt: FieldValue.serverTimestamp() } : { rejectedBy: admin.uid, rejectedAt: FieldValue.serverTimestamp() }), updatedAt: FieldValue.serverTimestamp() });
      tx.set(adminDb.collection('auditLogs').doc(), { actorUid: admin.uid, action: 'SELLER_PAYOUT_' + status, entityType: 'SELLER_PAYOUT', entityId: payoutId, amount: payout.amount, reason, createdAt: FieldValue.serverTimestamp() });
    });
    return res.json({ ok: true, status: action === 'APPROVE' ? 'APPROVED' : 'REJECTED', message: action === 'APPROVE' ? 'Payout approved. Send funds separately, then record the confirmed provider reference.' : 'Payout request rejected.' });
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
      if (payout.status !== 'APPROVED') throw clientError('Only an approved payout can be marked paid.', 409);
      if (debitSnap.exists) throw clientError('A payout ledger debit already exists.', 409);
      const ledgerRef = adminDb.collection('sellerLedger').doc(Buffer.from('marketplace-payout:' + payoutId).toString('base64url'));
      tx.set(ledgerRef, { sellerId: payout.sellerId, type: 'SELLER_PAYOUT', status: 'POSTED', amount: -Number(payout.amount), currency: payout.currency || 'KES', balanceBucket: 'AVAILABLE', payoutId, providerReference, idempotencyKey: ledgerRef.id, createdAt: FieldValue.serverTimestamp() });
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
    if (normalized.some(row => !row.sellerId || !money(row.amount)) || new Set(normalized.map(row => row.sellerId)).size !== normalized.length) {
      throw clientError('Each seller allocation must have a unique seller and positive whole-KSh amount.');
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
      if (allocationTotal > Number(refund.amount || 0)) throw clientError('Seller allocations cannot exceed the confirmed refund amount.', 409);
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
  throw clientError('Choose APPROVE, REJECT, MARK_PAID, or RECONCILE_REFUND.');
}
