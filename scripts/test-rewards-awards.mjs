import assert from 'node:assert/strict';
import { createFakeDb } from '../api/_lib/fake-firestore.js';
import { awardMarketplaceDeliveryRewards } from '../api/_lib/rewards-events.js';

const db = createFakeDb();
db.__seed('rewardsConfig', 'current', {
  enabled: true, pointsPerKes: 1, pointValueKes: 0.1, maxLiabilityKes: 10000,
  expiryDays: 365,
  buyer: { enabled: true, maxPointsPerOrder: 5000 },
  seller: { enabled: true, maxPointsPerOrder: 5000 },
});
db.__seed('orders', 'order-award-123', {
  orderId: 'HS-2026-000002', customerId: 'buyer-2', paymentStatus: 'PAID',
  items: [{ productId: 'p1', sellerId: 'seller-2', lineTotal: 250, quantity: 1 }],
  sellerFulfilment: { 'seller-2': { status: 'DELIVERED' } },
  firstPartyFulfilment: { status: 'DELIVERED' },
});
db.__seed('rewardAccounts', 'buyer-2', { uid: 'buyer-2', pointsBalance: 0 });
db.__seed('rewardAccounts', 'seller-2', { uid: 'seller-2', pointsBalance: 0 });

await awardMarketplaceDeliveryRewards('order-award-123', 'seller-2', db);
await awardMarketplaceDeliveryRewards('order-award-123', 'seller-2', db);

const entries = await db.collection('rewardLedger').where('orderDocumentId', '==', 'order-award-123').where('status', '==', 'POSTED').get();
assert.equal(entries.size, 2, 'seller and buyer awards are created only once');
assert.equal((await db.collection('rewardAccounts').doc('seller-2').get()).data().pointsBalance, 250);
assert.equal((await db.collection('rewardAccounts').doc('buyer-2').get()).data().pointsBalance, 250);
assert.equal((await db.collection('rewardsConfig').doc('current').get()).data().outstandingLiabilityKes, 50);

console.log('reward award/idempotency tests: 4 passed');
