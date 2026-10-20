// Offline tests for the marketplace listing promotion STK-push flow
// (api/_lib/routes/seller-promotions.js). Run via:
//   node --import ./scripts/promotion-stub.mjs scripts/test-seller-promotions.mjs
// FakeFirestore + fake M-Pesa provider — no network, no Firebase keys.
import assert from 'node:assert/strict';
import { startPromotionPayment, reconcilePromotionPayment } from '../api/_lib/routes/seller-promotions.js';

const db = globalThis.__promotionState.db;
const UID = 'seller-1';
const PRODUCT = 'prod-1234567890';
const PHONE = '0712345678';
const KEY = 'promote-key-000001';

let initiateCalls = [];
const liveCheckouts = new Set();
const provider = {
  async initiateStk({ phone, amount }) {
    initiateCalls.push({ phone, amount });
    const id = 'CHK' + initiateCalls.length;
    liveCheckouts.add(id);
    return { providerReference: id };
  },
  async checkStatus(id) {
    return { providerReference: String(id), status: liveCheckouts.has(String(id)) ? 'PENDING' : 'TIMEOUT',
      amount: null, transactionReference: null, eventId: 'check:' + id, reason: null };
  },
};
globalThis.__promotionState.provider = provider;

db.__seed('products', PRODUCT, { sellerUid: UID, status: 'ACTIVE', name: 'Heels' });

// 1. Happy path: a fresh request fires exactly ONE STK push and stores its checkout id.
{
  const res = await startPromotionPayment(db, provider, UID, { productId: PRODUCT, phone: PHONE, idempotencyKey: KEY });
  assert.equal(res.statusCode, 202);
  assert.equal(res.body.payment.status, 'PENDING');
  assert.equal(initiateCalls.length, 1);
  assert.deepEqual(initiateCalls[0], { phone: '0712345678', amount: 100 });
  const doc = await db.collection('sellerPromotionPayments').doc(res.body.payment.paymentId).get();
  assert.ok(doc.exists);
  assert.equal(doc.data().providerReference, 'CHK1');
}

// 2. Same key replay while PENDING with a live checkout -> reused, NO second STK push.
{
  const res = await startPromotionPayment(db, provider, UID, { productId: PRODUCT, phone: PHONE, idempotencyKey: KEY });
  assert.equal(res.body.reused, true);
  assert.equal(res.body.payment.providerReference, 'CHK1');
  assert.equal(initiateCalls.length, 1, 'must not double-initiate for the same live key');
}

// 3. Initiation failure must NOT leave a stuck PENDING ghost row; a retry with
//    a new key gets a brand-new STK push. The dead prior checkout (CHK1) is
//    settled at the provider first, so one extra checkStatus call happens
//    before initiateStk throws.
{
  const failing = { ...provider, async initiateStk() { throw new Error('provider down'); } };
  liveCheckouts.delete('CHK1'); // make the earlier checkout dead so no reuse short-circuit
  await assert.rejects(
    startPromotionPayment(db, failing, UID, { productId: PRODUCT, phone: PHONE, idempotencyKey: 'promote-key-000002' }),
    /provider down/,
  );
  const rows = db.__list('sellerPromotionPayments');
  const failedRow = rows.find(r => r.data.idempotencyKey === 'promote-key-000002');
  assert.ok(failedRow, 'failed attempt row exists');
  assert.equal(failedRow.data.status, 'FAILED', 'stuck PENDING ghost is expired on failure');
  const res = await startPromotionPayment(db, provider, UID, { productId: PRODUCT, phone: PHONE, idempotencyKey: 'promote-key-000003' });
  assert.equal(res.body.payment.status, 'PENDING');
  assert.equal(initiateCalls.length, 2, 'retry after failure sends a fresh STK push');
}

// 4. Expired prior checkout (dead on PrintPay) -> replaced by a brand-new STK push.
{
  liveCheckouts.delete('CHK2');
  const res = await startPromotionPayment(db, provider, UID, { productId: PRODUCT, phone: PHONE, idempotencyKey: 'promote-key-000004' });
  assert.equal(res.body.payment.providerReference, 'CHK3', 'expired checkout replaced by a brand-new one');
  assert.equal(initiateCalls.length, 3);
}

// 5. Reconcile: stuck PENDING row with NO providerReference older than 5 min -> TIMEOUT.
{
  const paymentId = 'f'.repeat(64);
  db.__seed('sellerPromotionPayments', paymentId, { paymentId, sellerId: UID, productId: PRODUCT, phone: PHONE, amount: 100, currency: 'KES', method: 'MPESA',
    status: 'PENDING', providerReference: null, createdAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(), updatedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString() });
  const payment = await reconcilePromotionPayment(db, provider, UID, paymentId);
  assert.equal(payment.status, 'TIMEOUT');
  assert.match(payment.failureReason, /could not be delivered/);
}

// 6. Reconcile: PAID at the provider applies the 7-day promotion to the product.
{
  const paymentId = 'e'.repeat(64);
  db.__seed('sellerPromotionPayments', paymentId, { paymentId, sellerId: UID, productId: PRODUCT, phone: PHONE, amount: 100, currency: 'KES', method: 'MPESA',
    status: 'PENDING', providerReference: 'CHKPAID', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
  const paidProvider = { ...provider, async checkStatus(id) { return { providerReference: String(id), status: 'PAID', amount: 100, transactionReference: 'T1', eventId: 'ev', reason: null }; } };
  const payment = await reconcilePromotionPayment(db, paidProvider, UID, paymentId);
  assert.equal(payment.status, 'PAID');
  assert.ok(payment.promotedUntil, 'promotion window applied');
  const product = await db.collection('products').doc(PRODUCT).get();
  assert.ok(product.data().promotedUntil);
}

console.log('6 seller promotion tests passed');
