import assert from 'node:assert/strict';
import {
  SELLER_PLANS,
  SELLER_BADGE_MONTHLY_FEE,
  normalizeSellerPhone,
  sellerSubscriptionPaymentId,
} from '../api/_lib/seller-subscription-core.js';

assert.deepEqual(
  Object.fromEntries(Object.entries(SELLER_PLANS).map(([code, plan]) => [code, plan.amount])),
  { STARTER: 150, STANDARD: 350, GROWTH: 800, UNLIMITED: 1500 },
);
assert.equal(SELLER_BADGE_MONTHLY_FEE, 50);
assert.deepEqual(
  Object.fromEntries(Object.entries(SELLER_PLANS).map(([code, plan]) => [code, plan.amount + SELLER_BADGE_MONTHLY_FEE])),
  { STARTER: 200, STANDARD: 400, GROWTH: 850, UNLIMITED: 1550 },
);
for (const [input, expected] of [
  ['0712345678', '+254712345678'],
  ['0112345678', '+254112345678'],
  ['+254712345678', '+254712345678'],
  ['254112345678', '+254112345678'],
  [' 0712 345 678 ', '+254712345678'],
]) assert.equal(normalizeSellerPhone(input), expected, input);
assert.throws(() => normalizeSellerPhone('12345'), /valid Kenyan M-Pesa number/);
assert.throws(() => normalizeSellerPhone('+254912345678'), /valid Kenyan M-Pesa number/);
const first = sellerSubscriptionPaymentId('seller-1', 'idempotency-key-123');
assert.equal(first, sellerSubscriptionPaymentId('seller-1', 'idempotency-key-123'));
assert.notEqual(first, sellerSubscriptionPaymentId('seller-1', 'idempotency-key-456'));
assert.match(first, /^[a-f0-9]{64}$/);
console.log('seller subscription tests: plan pricing, mandatory badge fee, phone normalization, and idempotency key passed');

import { getSellerEntitlements } from '../api/_lib/seller-entitlements-core.js';

function fakeEntitlementDb(seller, statuses = []) {
  return {
    collection(name) {
      if (name === 'sellers') return { doc: () => ({ get: async () => ({ exists: Boolean(seller), data: () => seller }) }) };
      if (name === 'products') return {
        where: () => ({ get: async () => ({ docs: statuses.map((status, i) => ({ id: String(i), data: () => ({ status }) })) }) }),
      };
      throw new Error('Unexpected collection: ' + name);
    },
  };
}
const now = new Date('2026-10-19T10:00:00.000Z');
const activeSeller = {
  status: 'ACTIVE',
  planCode: 'STARTER',
  billingStatus: 'ACTIVE',
  subscriptionExpiresAt: new Date('2026-11-19T10:00:00.000Z'),
};
const underLimit = await getSellerEntitlements(fakeEntitlementDb(activeSeller, ['ACTIVE', 'DRAFT', 'PUBLISHED']), 'seller-1', now);
assert.equal(underLimit.activeProductCount, 2);
assert.equal(underLimit.productLimit, 20);
assert.equal(underLimit.remainingProducts, 18);
assert.equal(underLimit.canPublish, true);
const atLimit = await getSellerEntitlements(fakeEntitlementDb(activeSeller, Array(20).fill('ACTIVE')), 'seller-1', now);
assert.equal(atLimit.canPublish, false);
assert.equal(atLimit.reason, 'PRODUCT_LIMIT_REACHED');
const expired = await getSellerEntitlements(fakeEntitlementDb({ ...activeSeller, subscriptionExpiresAt: new Date('2026-10-18T10:00:00.000Z') }), 'seller-1', now);
assert.equal(expired.canPublish, false);
assert.equal(expired.reason, 'SUBSCRIPTION_INACTIVE_OR_EXPIRED');
const unlimited = await getSellerEntitlements(fakeEntitlementDb({ ...activeSeller, planCode: 'UNLIMITED' }, Array(1200).fill('ACTIVE')), 'seller-1', now);
assert.equal(unlimited.canPublish, true);
assert.equal(unlimited.productLimit, null);
assert.equal(unlimited.remainingProducts, null);
const missing = await getSellerEntitlements(fakeEntitlementDb(null), 'seller-1', now);
assert.equal(missing.canPublish, false);
assert.equal(missing.reason, 'SELLER_NOT_FOUND');
console.log('seller entitlement tests: active subscription, expiry, plan limits, unlimited plan, and missing seller passed');
