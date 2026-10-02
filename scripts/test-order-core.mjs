// Offline test suite for api/_lib/order-core.js — NO network, NO Firebase
// credentials. Runs the real transactional logic against the in-memory fake
// Firestore in api/_lib/fake-firestore.js (which itself THROWS on any dotted
// write path, so "inventory stays an array" is enforced structurally).
//
// Run with: npm test
import assert from 'node:assert/strict';
import { createFakeDb } from '../api/_lib/fake-firestore.js';
import { normalizeKenyanPhone } from '../api/_lib/phone.js';
import {
  createOrderCore,
  applyVerifiedCallbackCore,
  adminOrderTransitionCore,
  unitPrice,
  PAYMENT_STATUS,
} from '../api/_lib/order-core.js';
import { deliveryFee, validateDelivery } from '../api/_lib/delivery.js';

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
const PRODUCT_ID = 'prod-boot-001';
const CATEGORIES = [
  { id: 'cat-1', name: 'Sneakers' },
];

function seedBase(overrides = {}) {
  const db = createFakeDb();
  db.__seed('settings', 'checkout', {
    deliveryEnabled: true,
    deliveryRates: { outsideJuja: 100, kiambu: 200, defaultCounty: 500, counties: { Nairobi: 300 } },
  });
  db.__seed('users', 'user-1', { uid: 'user-1', displayName: 'Jane Doe', email: 'jane@example.com', role: 'CUSTOMER' });
  db.__seed('products', PRODUCT_ID, {
    name: 'HerStep Boot',
    sku: 'HS-BOOT-1',
    categoryId: 'cat-1',
    price: 4000,
    salePrice: null,
    status: 'ACTIVE',
    inventory: [
      { size: '38', quantity: 5 },
      { size: '40', quantity: 3 },
      { size: '42', quantity: 2 },
    ],
    images: [{ url: 'https://res.cloudinary.com/x/y/boot.jpg', publicId: 'boot', resourceType: 'image' }],
    stockQuantity: 10,
    availableSizes: ['38', '40', '42'],
    ...overrides.product,
  });
  if (overrides.corruptInventory != null) {
    db.__seed('products', PRODUCT_ID, {
      name: 'Broken Shoe', sku: 'X', categoryId: 'cat-1', price: 1000, salePrice: null,
      status: 'ACTIVE', inventory: overrides.corruptInventory, images: [],
    });
  }
  return db;
}

function deps(db) {
  return {
    serverTimestamp: () => db.__serverTimestamp(),
    normalizePhone: normalizeKenyanPhone,
    now: () => new Date(Date.UTC(2026, 8, 30)),
    constants: { LOCATION: 'Juja Town, Jerry House, near Juja Posta, Outside Shop No. 12' },
  };
}

// EXACT payload shape Checkout.tsx sends today: no email anywhere.
function checkoutPayload() {
  return {
    uid: 'user-1',
    email: '', // token had no email — must still succeed (users doc fills it)
    emailVerified: false,
    cart: [
      { productId: PRODUCT_ID, size: '38', quantity: 2 },
      { productId: PRODUCT_ID, size: '40', quantity: 1 },
    ],
    delivery: {
      fullName: 'Jane Doe',
      phone: '0712 345 678',
      deliveryMethod: 'DELIVERY',
      location: 'Juja, Campus Road',
      instructions: 'Call on arrival',
    },
  };
}

// ---------------------------------------------------------------------------
console.log('order-core offline tests');
// ---------------------------------------------------------------------------

await test('checkout payload without email creates the order (no "Email address is required")', async () => {
  const db = seedBase();
  const res = await createOrderCore(db, deps(db), checkoutPayload());
  assert.equal(res.order.currency, 'KES');
  assert.ok(res.order.total > 0);
});

await test('created order contains delivery.fullName, delivery.phone (+254 normalised) and delivery.instructions', async () => {
  const db = seedBase();
  const res = await createOrderCore(db, deps(db), checkoutPayload());
  const order = db.__doc('orders', res.order.id);
  assert.equal(order.delivery.fullName, 'Jane Doe');
  assert.equal(order.delivery.phone, '+254712345678'); // initiate() regex ^\+254[17]\d{8}$ passes
  assert.equal(order.delivery.instructions, 'Call on arrival');
  assert.equal(order.delivery.deliveryMethod, 'DELIVERY');
  assert.deepEqual(Object.keys(order.delivery).sort(), ['deliveryMethod', 'fullName', 'instructions', 'location', 'phone']);
  // customerEmail comes from the users doc, never from the client payload.
  assert.equal(order.customerEmail, 'jane@example.com');
});

await test('inventory stays an ARRAY after reservation (fake db throws on dotted paths)', async () => {
  const db = seedBase();
  const res = await createOrderCore(db, deps(db), checkoutPayload());
  const product = db.__doc('products', PRODUCT_ID);
  assert.ok(Array.isArray(product.inventory), 'inventory must remain an array');
  assert.equal(product.stockQuantity, 7);
  assert.deepEqual(product.availableSizes, ['38', '40', '42']);
  const logs = db.__list('inventoryLogs');
  assert.equal(logs.length, 2);
  assert.ok(logs.every(l => l.data.reason === 'ORDER_RESERVED'));
  const history = db.__list('orderStatusHistory');
  assert.equal(history.length, 1);
  assert.equal(history[0].data.previousStatus, null);
  assert.equal(history[0].data.newStatus, 'PENDING');
  assert.equal(history[0].data.note, 'Order placed; awaiting payment.');
  void res;
});

await test('two sizes of ONE product decrement correctly with a single product update', async () => {
  const db = seedBase();
  await createOrderCore(db, deps(db), checkoutPayload());
  const product = db.__doc('products', PRODUCT_ID);
  const bySize = Object.fromEntries(product.inventory.map(i => [i.size, i.quantity]));
  assert.deepEqual(bySize, { '38': 3, '40': 2, '42': 2 });
  // subtotal 2*4000 + 1*4000 = 12000, delivery to Juja is always free.
  const order = db.__list('orders')[0].data;
  assert.equal(order.subtotal, 12000);
  assert.equal(order.deliveryFee, 0);
  assert.equal(order.total, 12000);
  assert.equal(order.total, order.subtotal + order.deliveryFee - order.discount, 'server total is subtotal + fee - discount');
});

await test('delivery fees use Juja, Kiambu, configured-area and default rules', async () => {
  const settings = { deliveryEnabled: true, deliveryRates: { outsideJuja: 100, kiambu: 200, defaultCounty: 500, counties: { Nairobi: 300 } } };
  assert.equal(deliveryFee(settings, 'Juja'), 0);
  assert.equal(deliveryFee(settings, 'juja town'), 0);
  assert.equal(deliveryFee(settings, 'Kiambu road'), 200);
  assert.equal(deliveryFee(settings, 'Nairobi CBD'), 300);
  assert.equal(deliveryFee(settings, 'Mombasa'), 500);
});

await test('delivery settings reject negative and fractional fees', async () => {
  assert.throws(() => validateDelivery({ deliveryEnabled: true, deliveryRates: { kiambu: -1, defaultCounty: 500, counties: {} } }), /Kiambu fee/);
  assert.throws(() => validateDelivery({ deliveryEnabled: true, deliveryRates: { kiambu: 200, defaultCounty: 500, counties: { Nairobi: 1.5 } } }), /whole number/);
});

await test('order numbers come from orderCounters/{year}.sequence: HS-2026-000001, -000002', async () => {
  const db = seedBase();
  const a = await createOrderCore(db, deps(db), checkoutPayload());
  const b = await createOrderCore(db, deps(db), checkoutPayload());
  assert.equal(a.order.orderId, 'HS-2026-000001');
  assert.equal(b.order.orderId, 'HS-2026-000002');
  assert.equal(db.__doc('orderCounters', '2026').sequence, 2);
});

await test('corrupted (non-array) inventory returns 409 "Product inventory needs repair", no writes', async () => {
  const db = seedBase({ corruptInventory: { '0': { size: '38', quantity: 5 } } });
  await assert.rejects(
    () => createOrderCore(db, deps(db), checkoutPayload()),
    err => err.statusCode === 409 && /needs repair/.test(err.message),
  );
  assert.equal(db.__list('orders').length, 0);
});

await test('validation rejects bad input BEFORE touching Firestore with human messages', async () => {
  const db = seedBase();
  const base = checkoutPayload();
  const cases = [
    [{ ...base, cart: [] }, /cart is empty/i],
    [{ ...base, cart: [{ productId: PRODUCT_ID, size: 38, quantity: 1 }] }, /string/i],
    [{ ...base, cart: [{ productId: PRODUCT_ID, size: '29', quantity: 1 }] }, /between "30" and "45"/],
    [{ ...base, cart: [{ productId: PRODUCT_ID, size: '38', quantity: 11 }] }, /1 to 10/],
    [{ ...base, cart: [
        { productId: PRODUCT_ID, size: '38', quantity: 1 },
        { productId: PRODUCT_ID, size: '38', quantity: 2 },
      ] }, /[Dd]uplicate/],
    [{ ...base, cart: Array.from({ length: 13 }, (_, n) => ({ productId: `p${n}`, size: '38', quantity: 1 })) }, /at most 12/],
    [{ ...base, delivery: { ...base.delivery, phone: '12345' } }, /valid Kenyan phone/i],
    [{ ...base, delivery: { ...base.delivery, fullName: '' } }, /Full name is required/],
    [{ ...base, delivery: { ...base.delivery, location: '' } }, /delivery location is required/i],
  ];
  for (const [payload, re] of cases) {
    await assert.rejects(() => createOrderCore(db, deps(db), payload), re);
  }
  assert.equal(db.__list('orders').length, 0, 'no orders written for invalid input');
});

await test('PAID callback marks order paid, sets receipt number, keeps inventory array', async () => {
  const db = seedBase();
  const d = deps(db);
  const res = await createOrderCore(db, d, checkoutPayload());
  const orderDocId = res.order.id;
  const paymentId = 'pay-abc-123';
  db.__seed('payments', paymentId, {
    paymentId, orderDocumentId: orderDocId, orderId: res.order.orderId, customerId: 'user-1',
    amount: res.order.total, currency: 'KES', phone: '+254712345678', method: 'MPESA',
    status: 'PENDING', providerReference: 'CPHCO123', transactionReference: null,
    receiptNumber: null, failureReason: null, createdAt: d.serverTimestamp(), initiatedAt: d.serverTimestamp(),
  });
  const out = await applyVerifiedCallbackCore(db, d, {
    providerReference: 'CPHCO123', status: 'PAID', amount: res.order.total,
    transactionReference: 'QNL2XABC', eventId: 'evt-1', orderId: res.order.orderId,
  });
  assert.equal(out.duplicate, false);
  assert.equal(out.status, 'PAID');
  const payment = db.__doc('payments', paymentId);
  assert.equal(payment.status, 'PAID');
  assert.equal(payment.receiptNumber, `HSP-${paymentId.replace(/[^A-Za-z0-9]/g, '').toUpperCase()}`);
  const order = db.__doc('orders', orderDocId);
  assert.equal(order.paymentStatus, 'PAID');
  assert.equal(order.paymentId, paymentId);
  assert.equal(order.paymentReference, 'QNL2XABC');
  assert.ok(Array.isArray(db.__doc('products', PRODUCT_ID).inventory));
});

await test('duplicate callback does NOTHING the second time', async () => {
  const db = seedBase();
  const d = deps(db);
  const res = await createOrderCore(db, d, checkoutPayload());
  db.__seed('payments', 'pay-dup', {
    paymentId: 'pay-dup', orderDocumentId: res.order.id, orderId: res.order.orderId, customerId: 'user-1',
    amount: res.order.total, currency: 'KES', phone: '+254712345678', method: 'MPESA',
    status: 'PENDING', providerReference: 'CPHDUP', transactionReference: null, receiptNumber: null,
    failureReason: null, createdAt: d.serverTimestamp(), initiatedAt: d.serverTimestamp(),
  });
  const cb = { providerReference: 'CPHDUP', status: 'PAID', amount: res.order.total, transactionReference: 'QT1', eventId: 'evt-dup' };
  const first = await applyVerifiedCallbackCore(db, d, cb);
  const second = await applyVerifiedCallbackCore(db, d, cb);
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(db.__list('orderStatusHistory').filter(h => h.data.eventType === 'PAYMENT_STATUS_CHANGED').length, 1);
  assert.equal(db.__list('notifications').filter(n => n.data.body?.includes('received your payment')).length, 1);
});

await test('wrong callback amount is rejected with 409 and changes nothing', async () => {
  const db = seedBase();
  const d = deps(db);
  const res = await createOrderCore(db, d, checkoutPayload());
  db.__seed('payments', 'pay-amt', {
    paymentId: 'pay-amt', orderDocumentId: res.order.id, orderId: res.order.orderId, customerId: 'user-1',
    amount: res.order.total, currency: 'KES', phone: '+254712345678', method: 'MPESA',
    status: 'PENDING', providerReference: 'CPHAMT', transactionReference: null, receiptNumber: null,
    failureReason: null, createdAt: d.serverTimestamp(), initiatedAt: d.serverTimestamp(),
  });
  await assert.rejects(
    () => applyVerifiedCallbackCore(db, d, {
      providerReference: 'CPHAMT', status: 'PAID', amount: res.order.total - 100, eventId: 'evt-bad-amount',
    }),
    err => err.statusCode === 409 && /amount does not match/.test(err.message),
  );
  assert.equal(db.__doc('payments', 'pay-amt').status, 'PENDING');
  assert.equal(db.__doc('orders', res.order.id).paymentStatus, 'PENDING');
});

for (const failStatus of ['CANCELLED', 'FAILED', 'TIMEOUT']) {
  await test(`${failStatus} callback restores stock as a NEW ARRAY and clears activePaymentId`, async () => {
    const db = seedBase();
    const d = deps(db);
    const res = await createOrderCore(db, d, checkoutPayload());
    db.__seed('payments', `pay-${failStatus}`, {
      paymentId: `pay-${failStatus}`, orderDocumentId: res.order.id, orderId: res.order.orderId, customerId: 'user-1',
      amount: res.order.total, currency: 'KES', phone: '+254712345678', method: 'MPESA',
      status: 'PENDING', providerReference: `CPH-${failStatus}`, transactionReference: null, receiptNumber: null,
      failureReason: null, createdAt: d.serverTimestamp(), initiatedAt: d.serverTimestamp(),
    });
    db.__updateForTest = null;
    const orderRef = db.collection('orders').doc(res.order.id);
    await orderRef.update({ activePaymentId: `pay-${failStatus}` });
    const out = await applyVerifiedCallbackCore(db, d, {
      providerReference: `CPH-${failStatus}`, status: PAYMENT_STATUS[failStatus],
      amount: res.order.total, eventId: `evt-${failStatus}`, reason: `user ${failStatus.toLowerCase()}`,
    });
    assert.equal(out.duplicate, false);
    const product = db.__doc('products', PRODUCT_ID);
    assert.ok(Array.isArray(product.inventory), 'restored inventory must be an array');
    const bySize = Object.fromEntries(product.inventory.map(i => [i.size, i.quantity]));
    assert.deepEqual(bySize, { '38': 5, '40': 3, '42': 2 }, 'stock fully restored');
    assert.equal(product.stockQuantity, 10);
    const order = db.__doc('orders', res.order.id);
    assert.equal(order.activePaymentId, null, 'customer can retry');
    assert.equal(order.paymentStatus, failStatus);
    assert.equal(order.inventoryReserved, false);
    const restoreLogs = db.__list('inventoryLogs').filter(l => l.data.reason === 'PAYMENT_CANCELLED_RESTORE');
    assert.equal(restoreLogs.length, 2);
  });
}

await test('admin cancel of an unpaid order restores stock (new array) + ORDER_CANCELLED logs', async () => {
  const db = seedBase();
  const d = deps(db);
  const res = await createOrderCore(db, d, checkoutPayload());
  await adminOrderTransitionCore(db, d, { actorUid: 'admin-1', orderDocumentId: res.order.id, orderStatus: 'CANCELLED', note: 'customer request' });
  const product = db.__doc('products', PRODUCT_ID);
  assert.ok(Array.isArray(product.inventory));
  assert.equal(product.stockQuantity, 10);
  const order = db.__doc('orders', res.order.id);
  assert.equal(order.orderStatus, 'CANCELLED');
  assert.equal(order.inventoryReserved, false);
  const logs = db.__list('inventoryLogs').filter(l => l.data.reason === 'ORDER_CANCELLED');
  assert.equal(logs.length, 2);
});

await test('admin transition accepts DELIVERED (VALID set, not TRANSITIONS keys)', async () => {
  const db = seedBase();
  const d = deps(db);
  const res = await createOrderCore(db, d, checkoutPayload());
  const id = res.order.id;
  // PAID so PROCESSING is allowed (callback resolves the payment by providerReference).
  db.__seed('payments', 'pay-deliv', {
    paymentId: 'pay-deliv', orderDocumentId: id, orderId: res.order.orderId, customerId: 'user-1',
    amount: res.order.total, currency: 'KES', phone: '+254712345678', method: 'MPESA',
    status: 'PENDING', providerReference: 'PFKDELIV', transactionReference: null, receiptNumber: null,
    failureReason: null, createdAt: d.serverTimestamp(), initiatedAt: d.serverTimestamp(),
  });
  await applyVerifiedCallbackCore(db, d, { providerReference: 'PFKDELIV', status: 'PAID', amount: res.order.total, transactionReference: 'QNDL1', eventId: 'evt-deliv-paid' });
  await adminOrderTransitionCore(db, d, { actorUid: 'admin-1', orderDocumentId: id, orderStatus: 'PROCESSING', note: '' });
  await adminOrderTransitionCore(db, d, { actorUid: 'admin-1', orderDocumentId: id, orderStatus: 'PROCESSED', note: '' });
  await adminOrderTransitionCore(db, d, { actorUid: 'admin-1', orderDocumentId: id, orderStatus: 'OUT_FOR_DELIVERY', note: '' });
  await adminOrderTransitionCore(db, d, { actorUid: 'admin-1', orderDocumentId: id, orderStatus: 'DELIVERED', note: 'handed over' });
  assert.equal(db.__doc('orders', id).orderStatus, 'DELIVERED');
  // Terminal: no further transitions from DELIVERED.
  await assert.rejects(
    () => adminOrderTransitionCore(db, d, { actorUid: 'admin-1', orderDocumentId: id, orderStatus: 'CANCELLED', note: '' }),
    err => err.statusCode === 409 && /Cannot move an order from Delivered to Cancelled\./.test(err.message),
  );
});

await test('invalid status rejected; PROCESSING requires PAID; human error messages', async () => {
  const db = seedBase();
  const d = deps(db);
  const res = await createOrderCore(db, d, checkoutPayload());
  const id = res.order.id;
  await assert.rejects(
    () => adminOrderTransitionCore(db, d, { actorUid: 'admin-1', orderDocumentId: id, orderStatus: 'SHIPPED', note: '' }),
    err => err.statusCode === 400 && err.message === 'A valid orderStatus is required.',
  );
  await assert.rejects(
    () => adminOrderTransitionCore(db, d, { actorUid: 'admin-1', orderDocumentId: id, orderStatus: 'DELIVERED', note: '' }),
    err => err.statusCode === 409 && err.message === 'Cannot move an order from Pending to Delivered.',
  );
  await assert.rejects(
    () => adminOrderTransitionCore(db, d, { actorUid: 'admin-1', orderDocumentId: id, orderStatus: 'PROCESSING', note: '' }),
    err => err.statusCode === 409 && /Payment must be confirmed/.test(err.message),
  );
});

await test('salePrice null gives the normal price; valid discount gives the sale price', async () => {
  assert.equal(unitPrice({ price: 4000, salePrice: null }), 4000);
  assert.equal(unitPrice({ price: 4000, salePrice: 0 }), 4000);
  assert.equal(unitPrice({ price: 4000, salePrice: 5000 }), 4000); // not lower -> ignore
  assert.equal(unitPrice({ price: 4000, salePrice: 3500 }), 3500);
  // end-to-end: discounted product charges the sale price
  const db = seedBase({ product: { salePrice: 3500 } });
  const res = await createOrderCore(db, deps(db), checkoutPayload());
  const order = db.__doc('orders', res.order.id);
  assert.equal(order.items[0].unitPrice, 3500);
  assert.equal(order.subtotal, 3 * 3500);
});

await test('COLLECTION pickup is always free', async () => {
  const db = seedBase();
  const payload = checkoutPayload();
  payload.delivery = { ...payload.delivery, deliveryMethod: 'COLLECTION', location: '' };
  const res = await createOrderCore(db, deps(db), payload);
  assert.equal(res.order.deliveryFee, 0);
  assert.equal(res.order.total, res.order.subtotal);
});

await test('delivery disabled in settings rejects DELIVERY with a clear message', async () => {
  const db = seedBase();
  db.__seed('settings', 'checkout', { deliveryEnabled: false, deliveryRates: {} });
  await assert.rejects(
    () => createOrderCore(db, deps(db), checkoutPayload()),
    /Delivery is currently unavailable/,
  );
});

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const [name, err] of failures) console.error(`FAILED: ${name}\n${err.stack}`);
  process.exit(1);
}
