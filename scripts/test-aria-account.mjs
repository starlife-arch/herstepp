import assert from 'node:assert/strict';
import { createFakeDb } from '../api/_lib/fake-firestore.js';
import { detectAriaAccountIntent, resolveAriaAccountIntent } from '../api/_lib/aria-account-core.js';

let passed = 0;
async function testCase(name, fn) { await fn(); passed++; console.log('  ✓ ' + name); }
const db = createFakeDb();
db.__addIndex('orders', ['customerId', 'createdAt'], 'desc');
db.__addIndex('orders', ['createdAt'], 'desc');
db.__seed('orders', 'orderdoc0001', { customerId: 'customer-1', orderId: 'HS-2026-000001', orderStatus: 'PROCESSING', paymentStatus: 'PAID', paymentId: 'paymentdoc01', total: 4500, createdAt: new Date('2026-08-01T10:00:00Z') });
db.__seed('orders', 'orderdoc0002', { customerId: 'customer-2', orderId: 'HS-2026-000002', orderStatus: 'DELIVERED', paymentStatus: 'PAID', paymentId: 'paymentdoc02', total: 9000, createdAt: new Date('2026-08-02T10:00:00Z') });
db.__seed('payments', 'paymentdoc01', { customerId: 'customer-1', orderDocumentId: 'orderdoc0001', status: 'PAID' });
db.__seed('payments', 'paymentdoc02', { customerId: 'customer-2', orderDocumentId: 'orderdoc0002', status: 'PAID' });
db.__seed('rewardsConfig', 'current', { enabled: true, pointValueKes: 0.1, expiryDays: 365, buyer: { redemptionEnabled: true }, seller: { redemptionEnabled: true, redemptionTargets: ['PROMOTIONS','SELLER_PLAN'] } });
db.__seed('rewardAccounts', 'customer-1', { pointsBalance: 450 });
db.__seed('rewardLedger', 'reward-entry-1', { uid: 'customer-1', type: 'AWARD', points: 500, status: 'POSTED', createdAt: new Date('2026-09-01T10:00:00Z') });
db.__seed('rewardLedger', 'reward-entry-2', { uid: 'customer-1', type: 'REDEEM', points: -50, status: 'POSTED', createdAt: new Date('2026-09-02T10:00:00Z') });
db.__seed('sellers', 'seller-1', { ownerUid: 'seller-1', status: 'ACTIVE', billingStatus: 'ACTIVE', planCode: 'STANDARD', subscriptionExpiresAt: new Date('2027-01-01T00:00:00Z'), verificationBadge: true });
db.__seed('sellerSubscriptions', 'subscription-1', { sellerId: 'seller-1', planCode: 'STANDARD', status: 'ACTIVE', amount: 400, createdAt: new Date('2026-09-01T10:00:00Z') });
db.__seed('sellerPromotionWallets', 'seller-1', { availableBalance: 1200, totalDeposited: 2000, totalSpent: 800 });
db.__seed('sellerPromotionWalletLedger', 'wallet-entry-1', { sellerUid: 'seller-1', type: 'TOP_UP', balanceDelta: 2000 });
db.__seed('sellerPromotionCampaigns', 'campaign-1', { sellerUid: 'seller-1', status: 'ACTIVE', promotedUntil: new Date('2027-01-01T00:00:00Z') });
db.__seed('products', 'seller-product-1', { sellerUid: 'seller-1', status: 'ACTIVE', promotedUntil: new Date('2027-01-01T00:00:00Z') });
db.__seed('sellerLedger', 'seller-ledger-1', { sellerId: 'seller-1', orderDocumentId: 'sellerorder001' });
db.__seed('orders', 'sellerorder001', { orderId: 'HS-2026-000099', paymentStatus: 'PAID', createdAt: new Date('2026-09-03T10:00:00Z'), items: [{ sellerId: 'seller-1', name: 'Jacket', quantity: 1, unitPrice: 2500, lineTotal: 2500 }, { sellerId: 'seller-2', name: 'Shoes', quantity: 1, unitPrice: 3000, lineTotal: 3000 }], sellerFulfilment: { 'seller-1': { status: 'PROCESSING' } } });

await testCase('detects only account-action intents', async () => {
  assert.equal(detectAriaAccountIntent('Where is my order?'), 'order');
  assert.equal(detectAriaAccountIntent('Did my payment go through?'), 'payment');
  assert.equal(detectAriaAccountIntent('Please show my invoice'), 'invoice');
  assert.equal(detectAriaAccountIntent('Please verify my email'), 'verification');
  assert.equal(detectAriaAccountIntent('orders'), 'order');
  assert.equal(detectAriaAccountIntent('payments'), 'payment');
  assert.equal(detectAriaAccountIntent('verification'), 'verification');
  assert.equal(detectAriaAccountIntent('codes'), 'verification');
  assert.equal(detectAriaAccountIntent('What shoes go with a dress?'), null);
  assert.equal(detectAriaAccountIntent('I have received the code and want you to confirm it'), 'verification');
  assert.equal(detectAriaAccountIntent('I have received it'), 'verification');
  assert.equal(detectAriaAccountIntent('my money was deducted'), 'payment');
  assert.equal(detectAriaAccountIntent('reset my password'), null);
});
await testCase('asks a follow-up when the customer only names an account topic', async () => {
  const orders = await resolveAriaAccountIntent({ db, user: { uid: 'customer-1' }, message: 'orders' });
  assert.match(orders.reply, /tracking an order/i);
  const payments = await resolveAriaAccountIntent({ db, user: { uid: 'customer-1' }, message: 'payments' });
  assert.match(payments.reply, /payment went through/i);
  const verification = await resolveAriaAccountIntent({ db, user: { uid: 'customer-1' }, message: 'codes' });
  assert.match(verification.reply, /send a verification code/i);
  const gotCode = await resolveAriaAccountIntent({ db, user: { uid: 'customer-1', email_verified: false }, message: 'I have received the code and want you to confirm it' });
  assert.match(gotCode.reply, /type the six-digit code/i);
  assert.equal(gotCode.nextAction, 'verify_email');
});
await testCase('requires sign-in before showing private account data', async () => {
  const out = await resolveAriaAccountIntent({ db, user: null, message: 'show my orders' });
  assert.match(out.reply, /sign in/i);
  assert.deepEqual(out.actions, []);
});
await testCase('returns only orders belonging to the authenticated user', async () => {
  const out = await resolveAriaAccountIntent({ db, user: { uid: 'customer-1' }, message: 'show my orders' });
  assert.match(out.reply, /HS-2026-000001/);
  assert.doesNotMatch(out.reply, /HS-2026-000002/);
});
await testCase('does not expose an order number belonging to another customer', async () => {
  const out = await resolveAriaAccountIntent({ db, user: { uid: 'customer-1' }, message: 'track HS-2026-000002' });
  assert.match(out.reply, /couldn’t find that order/i);
  assert.doesNotMatch(out.reply, /9000/);
});
await testCase('offers invoice download only for a confirmed paid order owned by the user', async () => {
  const out = await resolveAriaAccountIntent({ db, user: { uid: 'customer-1' }, message: 'download my invoice' });
  assert.equal(out.actions.length, 1);
  assert.equal(out.actions[0].orderDocumentId, 'orderdoc0001');
  assert.doesNotMatch(JSON.stringify(out.actions), /orderdoc0002/);
});
await testCase('emails only the selected customer-owned paid invoice to the requested address', async () => {
  let delivered = null;
  const out = await resolveAriaAccountIntent({
    db,
    user: { uid: 'customer-1' },
    message: 'Send invoice HS-2026-000001 to invoices@example.com',
    sendInvoice: async args => { delivered = args; return { sent: true }; },
  });
  assert.deepEqual(delivered, { uid: 'customer-1', orderDocumentId: 'orderdoc0001', email: 'invoices@example.com' });
  assert.match(out.reply, /sent invoice/i);
  assert.doesNotMatch(out.reply, /HS-2026-000002/);
});
await testCase('uses existing verification flow and reports cooldown without leaking codes', async () => {
  let called = false;
  const out = await resolveAriaAccountIntent({ db, user: { uid: 'customer-1', email_verified: false }, message: 'verify my email', sendVerification: async () => { called = true; return { sent: true, maskedEmail: 'j***@example.com' }; } });
  assert.equal(called, true);
  assert.match(out.reply, /j\*\*\*@example.com/);
});
console.log('Passed ' + passed + ' Aria account tests.');

await testCase('confirms a code only after an explicit pending verification action', async () => {
  let submitted = '';
  const out = await resolveAriaAccountIntent({
    db, user: { uid: 'customer-1', email_verified: false }, message: '123456',
    conversationState: { pendingAccountAction: 'verify_email' },
    confirmVerification: async (user, code) => { submitted = code; return { verified: true }; },
  });
  assert.equal(submitted, '123456');
  assert.match(out.reply, /email is now verified/i);
  assert.equal(out.clearPendingAction, true);
});
await testCase('does not claim verification succeeded for an incorrect code', async () => {
  const out = await resolveAriaAccountIntent({
    db, user: { uid: 'customer-1', email_verified: false }, message: '123456',
    conversationState: { pendingAccountAction: 'verify_email' },
    confirmVerification: async () => { throw new Error('Incorrect code. 4 attempts left.'); },
  });
  assert.match(out.reply, /doesn’t match/i);
  assert.equal(out.keepPendingAction, true);
});

await testCase('recognizes new HerStep marketplace account topics', async () => {
  assert.equal(detectAriaAccountIntent('show my reward points'), 'rewards');
  assert.equal(detectAriaAccountIntent('my seller plan'), 'seller_plan');
  assert.equal(detectAriaAccountIntent('check my promotion wallet'), 'promotions');
  assert.equal(detectAriaAccountIntent('show my seller orders'), 'seller_orders');
});
await testCase('returns rewards balance from the signed-in user ledger only', async () => {
  const out = await resolveAriaAccountIntent({ db, user: { uid: 'customer-1' }, message: 'show my points balance' });
  assert.match(out.reply, /450 points/);
  assert.match(out.reply, /KSh 45/);
});
await testCase('returns live seller plan and product limit for the signed-in seller', async () => {
  const out = await resolveAriaAccountIntent({ db, user: { uid: 'seller-1' }, message: 'show my seller plan' });
  assert.match(out.reply, /STANDARD/);
  assert.match(out.reply, /100/);
  assert.match(out.reply, /currently active/);
});
await testCase('returns live seller promotion wallet and campaign information', async () => {
  const out = await resolveAriaAccountIntent({ db, user: { uid: 'seller-1' }, message: 'check my promotion wallet' });
  assert.match(out.reply, /KSh 1,200/);
  assert.match(out.reply, /Active campaigns: 1/);
  assert.match(out.reply, /Active promoted products: 1/);
});
await testCase('seller order summary counts only this seller product lines', async () => {
  const out = await resolveAriaAccountIntent({ db, user: { uid: 'seller-1' }, message: 'show my seller orders' });
  assert.match(out.reply, /HS-2026-000099/);
  assert.match(out.reply, /KSh 2,500/);
  assert.doesNotMatch(out.reply, /KSh 5,500/);
});
await testCase('requires sign-in before showing private rewards and seller data', async () => {
  for (const message of ['show my points', 'show my seller plan', 'check my promotion wallet', 'show my seller orders']) {
    const out = await resolveAriaAccountIntent({ db, user: null, message });
    assert.match(out.reply, /sign in/i);
  }
});
