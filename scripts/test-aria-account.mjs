import assert from 'node:assert/strict';
import { createFakeDb } from '../api/_lib/fake-firestore.js';
import { detectAriaAccountIntent, resolveAriaAccountIntent } from '../api/_lib/aria-account-core.js';

let passed = 0;
async function testCase(name, fn) { await fn(); passed++; console.log('  ✓ ' + name); }
const db = createFakeDb();
db.__addIndex('orders', ['customerId', 'createdAt'], 'desc');
db.__seed('orders', 'orderdoc0001', { customerId: 'customer-1', orderId: 'HS-2026-000001', orderStatus: 'PROCESSING', paymentStatus: 'PAID', paymentId: 'paymentdoc01', total: 4500, createdAt: new Date('2026-08-01T10:00:00Z') });
db.__seed('orders', 'orderdoc0002', { customerId: 'customer-2', orderId: 'HS-2026-000002', orderStatus: 'DELIVERED', paymentStatus: 'PAID', paymentId: 'paymentdoc02', total: 9000, createdAt: new Date('2026-08-02T10:00:00Z') });
db.__seed('payments', 'paymentdoc01', { customerId: 'customer-1', orderDocumentId: 'orderdoc0001', status: 'PAID' });
db.__seed('payments', 'paymentdoc02', { customerId: 'customer-2', orderDocumentId: 'orderdoc0002', status: 'PAID' });

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
});
await testCase('asks a follow-up when the customer only names an account topic', async () => {
  const orders = await resolveAriaAccountIntent({ db, user: { uid: 'customer-1' }, message: 'orders' });
  assert.match(orders.reply, /tracking an order/i);
  const payments = await resolveAriaAccountIntent({ db, user: { uid: 'customer-1' }, message: 'payments' });
  assert.match(payments.reply, /payment went through/i);
  const verification = await resolveAriaAccountIntent({ db, user: { uid: 'customer-1' }, message: 'codes' });
  assert.match(verification.reply, /send a verification code/i);
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
