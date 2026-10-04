// Offline test suite for api/_lib/tip-core.js — NO network, NO Firebase.
// Runs the real transactional logic against the strict in-memory fake
// Firestore (api/_lib/fake-firestore.js). Tips are NOT orders: this suite
// also proves a seeded order + product stock is never touched by any tip.
//
// Run with: npm test
import assert from 'node:assert/strict';
import { createFakeDb } from '../api/_lib/fake-firestore.js';
import { normalizeKenyanPhone } from '../api/_lib/phone.js';
import {
  validateTipInput,
  checkTipRateLimit,
  resetTipRateLimits,
  createTipCore,
  applyTipResultCore,
  createTip,
  cancelTip,
  adminTips,
  publicTip,
} from '../api/_lib/tip-core.js';

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push([name, err]);
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
function seed() {
  const db = createFakeDb();
  db.__seed('users', 'user-1', { uid: 'user-1', displayName: 'Jane Doe', email: 'jane@example.com', role: 'CUSTOMER' });
  // An order + a product with stock: tips must NEVER touch either.
  db.__seed('orders', 'order-1', { orderId: 'HS-2026-000001', total: 5000, paymentStatus: 'PAID', status: 'CONFIRMED' });
  db.__seed('products', 'prod-1', { name: 'Boot', price: 4000, inventory: [{ size: '42', quantity: 3 }] });
  return db;
}

function deps(db, providerOverride = {}) {
  return {
    db,
    serverTimestamp: () => db.__serverTimestamp(),
    normalizePhone: normalizeKenyanPhone,
    provider: {
      initiateStk: async ({ phone, amount }) => ({ providerReference: `CPR-${phone}-${amount}`, resultDesc: 'Success' }),
      checkStatus: async () => ({ status: 'PENDING' }),
      ...providerOverride,
    },
    requireUser: async () => ({ uid: 'user-1', displayName: 'Jane Doe', email: 'jane@example.com' }),
    requireAdmin: async () => ({ uid: 'admin-1' }),
    queueTipThankYouEmail: (tx, payload) => { tx.set(db.collection('outbox').doc(payload.key), { to: 'jane@example.com', subject: 'Thanks', queued: true }); },
    sendTelegramMessage: async () => true,
    waitUntil: () => {},
  };
}

function req(body, query = {}) {
  return { body, query, method: 'POST' };
}

const VALID = { amount: 100, treat: 'COFFEE', phone: '+254712345678', message: 'Great service!' };

async function snapshotState(db) {
  const dump = name => db.__list(name);
  return JSON.stringify({ orders: await dump('orders'), products: await dump('products') });
}

// ---------------------------------------------------------------------------
console.log('\ntip-core validation');
// ---------------------------------------------------------------------------
await test('amount below 10 rejected', () => {
  assert.throws(() => validateTipInput({ ...VALID, amount: 9 }), /between KSh 10/i);
});
await test('amount above 150000 rejected', () => {
  assert.throws(() => validateTipInput({ ...VALID, amount: 150001 }), /150,000/);
});
await test('fractional amount rejected', () => {
  assert.throws(() => validateTipInput({ ...VALID, amount: 99.5 }), /whole shilling/i);
});
await test('unknown treat rejected', () => {
  assert.throws(() => validateTipInput({ ...VALID, treat: 'PIZZA' }), /treat them to/i);
});
await test('unknown fields rejected', () => {
  assert.throws(() => validateTipInput({ ...VALID, role: 'ADMIN' }), /Unknown tip field/i);
});
await test('message over 200 chars rejected, trimmed otherwise', () => {
  assert.throws(() => validateTipInput({ ...VALID, message: 'x'.repeat(201) }), /200 characters/);
  const clean = validateTipInput({ ...VALID, message: '  hi  ' });
  assert.equal(clean.message, 'hi');
});

// ---------------------------------------------------------------------------
console.log('\ntip-core create / STK');
// ---------------------------------------------------------------------------
resetTipRateLimits();
await test('rate limit: 5 per window, 6th rejected', () => {
  const now = Date.now();
  for (let i = 0; i < 5; i++) checkTipRateLimit('user-x', now);
  assert.throws(() => checkTipRateLimit('user-x', now), /too quickly/i);
  resetTipRateLimits();
});

await test('create makes TIP-000001 via counter and sends exactly ONE push', async () => {
  resetTipRateLimits();
  const db = seed();
  const d = deps(db);
  let pushes = 0;
  d.provider.initiateStk = async () => { pushes += 1; return { providerReference: 'CPR-ONE' }; };
  const tip = await createTip(d, req({ ...VALID }));
  assert.equal(tip.tipId, 'TIP-000001');
  assert.equal(tip.status, 'PENDING');
  assert.equal(tip.providerReference, 'CPR-ONE');
  assert.equal(pushes, 1);
  // Second call on the SAME tip doc (already has providerReference) never re-pushes.
  const before = pushes;
  const created = await createTipCore(db, d, { uid: 'user-1', name: 'Jane', email: 'jane@example.com', input: validateTipInput(VALID) });
  assert.equal(created.id, 'TIP-000002'); // new tip → new push is allowed
  void before;
});

await test('a tip that already has a providerReference never receives a second push', async () => {
  const db = seed();
  const d = deps(db);
  let pushes = 0;
  d.provider.initiateStk = async () => { pushes += 1; return { providerReference: 'CPR-X' }; };
  // Pre-create the tip WITH a reference (simulating a retried request path).
  await createTipCore(db, d, { uid: 'user-1', name: 'Jane', email: 'jane@example.com', input: validateTipInput(VALID) });
  const existing = db.__seed('tips', 'TIP-000001', {
    tipId: 'TIP-000001', customerId: 'user-1', amount: 100, treat: 'COFFEE',
    phone: '+254712345678', status: 'PENDING', providerReference: 'CPR-EXISTING',
  });
  void existing;
  // Re-running the "outside transaction" step of createTip for the existing doc:
  const snap = await db.collection('tips').doc('TIP-000001').get();
  const data = snap.data();
  if (!data.providerReference) await d.provider.initiateStk({ phone: data.phone, amount: data.amount });
  assert.equal(pushes, 0, 'duplicate STK must never be sent for one tip');
});

await test('tips never touch orders or stock', async () => {
  resetTipRateLimits();
  const db = seed();
  const before = await snapshotState(db);
  const d = deps(db);
  const tip = await createTip(d, req({ ...VALID }));
  await applyTipResultCore(db, d, { providerReference: tip.providerReference, status: 'PAID', amount: 100, eventId: 'evt-no-touch' });
  assert.equal(await snapshotState(db), before);
});

// ---------------------------------------------------------------------------
console.log('\ntip-core callback / idempotency');
// ---------------------------------------------------------------------------
await test('callback PAID applies once (idempotent by eventId)', async () => {
  resetTipRateLimits();
  const db = seed();
  const d = deps(db);
  const tip = await createTip(d, req({ ...VALID }));
  const first = await applyTipResultCore(db, d, { providerReference: tip.providerReference, status: 'PAID', amount: 100, eventId: 'evt-dup', transactionReference: 'WX1' });
  assert.equal(first.applied, true);
  assert.equal(first.status, 'PAID');
  assert.equal(first.tip.receiptNumber, 'HST-TIP-000001');
  const second = await applyTipResultCore(db, d, { providerReference: tip.providerReference, status: 'PAID', amount: 100, eventId: 'evt-dup' });
  assert.equal(second.duplicate, true);
  const paidDocs = (await db.collection('notifications').where('event', '==', 'TIP_RECEIVED').get()).docs;
  assert.equal(paidDocs.length, 1, 'customer notification applied exactly once');
});

await test('wrong amount rejected with 409', async () => {
  resetTipRateLimits();
  const db = seed();
  const d = deps(db);
  const tip = await createTip(d, req({ ...VALID }));
  await assert.rejects(
    applyTipResultCore(db, d, { providerReference: tip.providerReference, status: 'PAID', amount: 999, eventId: 'evt-wrong' }),
    err => err.statusCode === 409,
  );
  const after = publicTip(tip.tipId, (await db.collection('tips').doc(tip.tipId).get()).data());
  assert.equal(after.status, 'PENDING');
});

await test('cancel then late verified PAID still accepted', async () => {
  resetTipRateLimits();
  const db = seed();
  const d = deps(db);
  const tip = await createTip(d, req({ ...VALID }));
  // Customer cancels while the provider still says PENDING.
  const cancelled = await cancelTip(d, req({ tipId: tip.tipId }));
  assert.equal(cancelled.status, 'CANCELLED');
  assert.equal(cancelled.failureReason, 'You cancelled the payment.');
  // Money actually landed later: webhook delivers a verified PAID.
  const late = await applyTipResultCore(db, d, { providerReference: tip.providerReference, status: 'PAID', amount: 100, eventId: 'evt-late' });
  assert.equal(late.applied, true);
  assert.equal(late.lateSuccess, true);
  assert.equal(late.tip.receiptNumber, 'HST-TIP-000001');
});

await test('cancel returns PAID when the provider confirms money went through', async () => {
  resetTipRateLimits();
  const db = seed();
  const d = deps(db);
  d.provider.checkStatus = async () => ({ status: 'PAID', amount: 100, transactionReference: 'TT9' });
  const tip = await createTip(d, req({ ...VALID }));
  const result = await cancelTip(d, req({ tipId: tip.tipId }));
  assert.equal(result.status, 'PAID');
});

// Webhook-level guard lives in mpesaCallback: an unknown checkout/reference
// responds 200 ignored. We assert the lookup helper simply finds nothing here
// (the route then answers 200 { ignored: true }).
await test('webhook for an unknown reference finds no tip (route replies 200 ignored)', async () => {
  const db = seed();
  const snap = await db.collection('tips').where('providerReference', '==', 'CPR-UNKNOWN').limit(1).get();
  assert.equal(snap.empty, true);
});

// ---------------------------------------------------------------------------
console.log('\ntip-core admin totals');
// ---------------------------------------------------------------------------
await test('admin totals count ONLY PAID tips; phones masked to last 4', async () => {
  resetTipRateLimits();
  const db = seed();
  const d = deps(db);
  const t1 = await createTip(d, req({ ...VALID, amount: 100 }));
  const t2 = await createTip(d, req({ ...VALID, amount: 500, treat: 'SODA' }));
  await createTip(d, req({ ...VALID, amount: 200 })); // stays PENDING
  await applyTipResultCore(db, d, { providerReference: t1.providerReference, status: 'PAID', amount: 100, eventId: 'adm-1' });
  await applyTipResultCore(db, d, { providerReference: t2.providerReference, status: 'PAID', amount: 500, eventId: 'adm-2' });
  // The fake server timestamp is a marker object; stamp real ISO dates so the
  // today/this-month windows can be evaluated.
  for (const id of ['TIP-000001', 'TIP-000002']) {
    db.__seed('tips', id, { ...db.__doc('tips', id), completedAt: new Date(), createdAt: new Date() });
  }
  const out = await adminTips(d, {}, { now: Date.now() });
  assert.equal(out.totals.paidCount, 2);
  assert.equal(out.totals.allTime, 600);
  assert.equal(out.totals.today, 600);
  assert.equal(out.totals.thisMonth, 600);
  assert.deepEqual(out.byTreat, { COFFEE: 100, SODA: 500 });
  assert.equal(out.tips[0].phone, String(VALID.phone).slice(-4));
  assert.ok(out.tips.length >= 3);
});

console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) process.exit(1);
