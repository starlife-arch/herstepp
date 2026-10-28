import assert from 'node:assert/strict';
import { createFakeDb } from '../api/_lib/fake-firestore.js';
import { reverseMarketplaceOrderRewards } from '../api/_lib/rewards-refunds.js';

const db = createFakeDb();
db.__seed('orders', 'order-12345678', { orderId: 'HS-2026-000001', customerId: 'buyer-1' });
db.__seed('rewardsConfig', 'current', { pointValueKes: 0.1, outstandingLiabilityKes: 30 });
db.__seed('rewardAccounts', 'buyer-1', { uid: 'buyer-1', pointsBalance: 100 });
db.__seed('rewardAccounts', 'seller-1', { uid: 'seller-1', pointsBalance: 200 });
db.__seed('rewardLedger', 'buyer-award', {
  uid: 'buyer-1', accountType: 'BUYER', type: 'EARN', points: 100,
  orderDocumentId: 'order-12345678', status: 'POSTED',
});
db.__seed('rewardLedger', 'seller-award', {
  uid: 'seller-1', accountType: 'SELLER', type: 'EARN', points: 200,
  orderDocumentId: 'order-12345678', status: 'POSTED',
});

const first = await reverseMarketplaceOrderRewards('order-12345678', db);
assert.equal(first.reversed, 2, 'refund reverses buyer and seller awards once');
assert.equal((await db.collection('rewardAccounts').doc('buyer-1').get()).data().pointsBalance, 0);
assert.equal((await db.collection('rewardAccounts').doc('seller-1').get()).data().pointsBalance, 0);
assert.equal((await db.collection('rewardLedger').where('orderDocumentId', '==', 'order-12345678').where('type', '==', 'REFUND_REVERSAL').get()).size, 2);

const second = await reverseMarketplaceOrderRewards('order-12345678', db);
assert.equal(second.reversed, 0, 'repeating the same refund must not duplicate reversal entries');
assert.equal((await db.collection('rewardLedger').where('orderDocumentId', '==', 'order-12345678').where('type', '==', 'REFUND_REVERSAL').get()).size, 2);

console.log('reward refund tests: 4 passed');
