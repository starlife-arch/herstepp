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
