import assert from 'node:assert/strict';
import { calculateOutstandingLiability, pointsAllowedUnderLiabilityCap } from '../api/_lib/rewards-liability.js';

const now = Date.UTC(2026, 9, 28);
const entries = [
  { status: 'POSTED', points: 100, expiresAt: new Date(now + 86400000) },
  { status: 'POSTED', points: 200, expiresAt: new Date(now - 1000) },
  { status: 'POSTED', points: -25 }, // redeemed/refunded points reduce liability
  { status: 'PENDING', points: 500 },
  { status: 'POSTED', points: 50 }, // no expiry configured
];

assert.equal(calculateOutstandingLiability(entries, 0.1, now), 12.5,
  'expired positive awards and non-posted entries must not count toward liability');
assert.equal(calculateOutstandingLiability([{ status: 'POSTED', points: 40, expiresAt: new Date(now) }], 0.5, now), 0,
  'an award expires at its expiry timestamp');
assert.equal(calculateOutstandingLiability([{ status: 'POSTED', points: -20, expiresAt: new Date(now - 1000) }], 0.1, now), 0,
  'an expired negative ledger movement must not create a negative liability');
assert.equal(pointsAllowedUnderLiabilityCap(1000, 100, 90, 0.1), 100,
  'award points must be capped by remaining liability headroom');
assert.equal(pointsAllowedUnderLiabilityCap(1000, 100, 100, 0.1), 0,
  'no new points are awarded when liability cap is reached');

console.log('rewards-liability tests: 5 passed');
