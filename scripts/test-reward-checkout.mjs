import assert from 'node:assert/strict';
import { createFakeDb } from '../api/_lib/fake-firestore.js';
import { createOrderCore, applyVerifiedCallbackCore } from '../api/_lib/order-core.js';
import { normalizeKenyanPhone } from '../api/_lib/phone.js';

function seed() {
  const db = createFakeDb();
  db.__seed('settings', 'checkout', { deliveryEnabled: false, collectionEnabled: true });
  db.__seed('users', 'buyer-1', { uid: 'buyer-1', displayName: 'Buyer One', email: 'buyer@example.com' });
  db.__seed('products', 'product-1', {
    name: 'Test Dress', sku: 'DRESS-1', price: 1000, status: 'ACTIVE',
    inventory: [{ size: 'M', quantity: 5 }], images: [], stockQuantity: 5, availableSizes: ['M'],
  });
  db.__seed('rewardsConfig', 'current', {
    enabled: true, pointsPerKes: 1, pointValueKes: 0.1, maxLiabilityKes: 100000,
    buyer: { enabled: true, redemptionEnabled: true, maxRedemptionPercent: 20, minRedeemPoints: 100 },
    seller: { enabled: true },
  });
  db.__seed('rewardLedger', 'earned-1', {
    uid: 'buyer-1', accountType: 'BUYER', type: 'EARN', points: 500, status: 'POSTED',
  });
  db.__seed('rewardAccounts', 'buyer-1', { uid: 'buyer-1', pointsBalance: 500 });
  return db;
}
const deps = db => ({
  serverTimestamp: () => db.__serverTimestamp(),
  normalizePhone: normalizeKenyanPhone,
  now: () => new Date('2026-10-28T10:00:00.000Z'),
  constants: { LOCATION: 'Juja Collection Point' },
});
const payload = {
  uid: 'buyer-1', email: '', emailVerified: false, rewardPoints: 500,
  cart: [{ productId: 'product-1', size: 'M', quantity: 1 }],
  delivery: { fullName: 'Buyer One', phone: '0712345678', deliveryMethod: 'COLLECTION', location: '' },
};

{
  const db = seed();
  const created = await createOrderCore(db, deps(db), payload);
  assert.equal(created.order.rewardPointsRedeemed, 500);
  assert.equal(created.order.rewardDiscountKes, 50);
  assert.equal(created.order.total, 950);
  assert.equal((await db.collection('rewardAccounts').doc('buyer-1').get()).data().pointsBalance, 0);
  const orderDoc = (await db.collection('orders').doc(created.order.id).get()).data();
  const reserve = await db.collection('rewardLedger').doc(orderDoc.rewardReservationLedgerId).get();
  assert.equal(reserve.data().type, 'REDEEM_RESERVE');
  console.log('✓ checkout reserves points and applies server-calculated discount');
}

{
  const db = seed();
  const created = await createOrderCore(db, deps(db), payload);
  await db.collection('payments').doc('payment-1').set({
    orderDocumentId: created.order.id, orderId: created.order.orderId,
    providerReference: 'provider-1', status: 'PENDING', amount: 950, currency: 'KES',
  });
  const result = await applyVerifiedCallbackCore(db, deps(db), {
    providerReference: 'provider-1', status: 'FAILED', amount: 950,
    eventId: 'failed-checkout-reward-test', reason: 'test failure',
  });
  assert.equal(result.status, 'FAILED');
  assert.equal((await db.collection('rewardAccounts').doc('buyer-1').get()).data().pointsBalance, 500);
  const order = (await db.collection('orders').doc(created.order.id).get()).data();
  assert.equal(order.total, 1000, 'failed payment removes the reward discount before retry');
  assert.equal(order.rewardPointsReleased, true);
  const reserve = await db.collection('rewardLedger').doc((await db.collection('orders').doc(created.order.id).get()).data().rewardReservationLedgerId).get();
  assert.equal(reserve.data().status, 'REVERSED');
  const restore = await db.collection('rewardLedger').doc(Buffer.from('checkout-restore:' + created.order.id).toString('base64url')).get();
  assert.equal(restore.data().points, 500);
  console.log('✓ failed payment restores points and removes checkout discount');
}
