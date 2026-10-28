import assert from 'node:assert/strict';
import { calculateSellerSubscriptionPrice, DEFAULT_SELLER_TERM_DISCOUNTS } from '../api/_lib/seller-subscription-pricing.js';

const monthly = calculateSellerSubscriptionPrice('STARTER', 1);
assert.equal(monthly.amount, 200);
assert.equal(monthly.discountPercent, 0);
assert.equal(monthly.badgeAmount, 50);

const threeMonths = calculateSellerSubscriptionPrice('STARTER', 3);
assert.equal(threeMonths.planSubtotal, 450);
assert.equal(threeMonths.discountAmount, 23);
assert.equal(threeMonths.badgeAmount, 150);
assert.equal(threeMonths.amount, 577);

const annual = calculateSellerSubscriptionPrice('UNLIMITED', 12);
assert.equal(annual.planSubtotal, 18000);
assert.equal(annual.discountPercent, 20);
assert.equal(annual.discountAmount, 3600);
assert.equal(annual.badgeAmount, 600);
assert.equal(annual.amount, 15000);

const custom = calculateSellerSubscriptionPrice('GROWTH', 6, { ...DEFAULT_SELLER_TERM_DISCOUNTS, 6: 15 });
assert.equal(custom.discountAmount, 720);
assert.equal(custom.amount, 4380);
assert.throws(() => calculateSellerSubscriptionPrice('UNKNOWN', 12), /valid seller subscription plan/);
assert.throws(() => calculateSellerSubscriptionPrice('STARTER', 2), /valid billing term/);
assert.equal(calculateSellerSubscriptionPrice('STARTER', 12, { 12: 99 }).discountPercent, 50);
console.log('seller subscription pricing tests passed');
