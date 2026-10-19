import { FieldValue } from 'firebase-admin/firestore';
import { adminDb, requireAdmin, requireUser } from '../firebase-admin.js';
import { clientError, methodNotAllowed } from '../http.js';

const clean = (value, max = 180) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const money = value => Number.isSafeInteger(value) && value > 0 && value <= 10_000_000;
const RESERVED = new Set(['REQUESTED', 'APPROVED']);
const iso = value => value?.toDate?.().toISOString?.() ?? null;
const safePayout = doc => {
  const d = doc.data() || {};
  return {
    id: doc.id, sellerId: d.sellerId, amount: d.amount, currency: d.currency || 'KES',
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
    const ledger = ledgerSnap.docs.map(doc => doc.data());
    const payouts = payoutsSnap.docs.map(safePayout);
    const available = ledger.filter(row => row.balanceBucket === 'AVAILABLE').reduce((sum, row) => sum + Number(row.amount || 0), 0);
    const reserved = payoutsSnap.docs.filter(doc => RESERVED.has(doc.data()?.status)).reduce((sum, doc) => sum + Number(doc.data()?.amount || 0), 0);
    return res.json({ currency: 'KES', availableBalance: Math.max(0, available - reserved), pendingBalance: ledger.filter(row => row.balanceBucket === 'PENDING').reduce((sum, row) => sum + Number(row.amount || 0), 0), payouts });
  }
  if (req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);
  const sellerSnap = await sellerRef.get();
  if (!sellerSnap.exists || sellerSnap.data()?.ownerUid !== user.uid || sellerSnap.data()?.status !== 'ACTIVE') {
    throw clientError('An approved, active seller account is required.', 403);
  }
  const amount = req.body?.amount;
  const phone = normalizeKenyanPhone(req.body?.payoutPhone);
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
    if (existing.exists) return; // idempotent retry of same request
    const available = ledgerSnap.docs.filter(doc => doc.data()?.balanceBucket === 'AVAILABLE').reduce((sum, doc) => sum + Number(doc.data()?.amount || 0), 0);
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
    const snap = await adminDb.collection('sellerPayouts').orderBy('createdAt', 'desc').limit(200).get();
    return res.json({ payouts: snap.docs.map(safePayout) });
  }
  if (req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);
  const action = clean(req.body?.action, 30).toUpperCase();
  const payoutId = clean(req.body?.payoutId, 180);
  const reason = clean(req.body?.reason, 500);
  if (!payoutId) throw clientError('Payout request ID is required.');
  if (['REJECT', 'APPROVE'].includes(action) && !reason) throw clientError('A reason or review note is required.');
  const ref = adminDb.collection('sellerPayouts').doc(payoutId);
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
  throw clientError('Choose APPROVE, REJECT, or MARK_PAID.');
}
