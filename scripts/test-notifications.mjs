import assert from 'node:assert/strict';
import { emailId, queueEmail, deliverQueuedEmail, deliverQueuedEmailInline } from '../api/_lib/email-service.js';
import { emailHtml, orderReceiptEmail } from '../api/_lib/email-templates.js';
import { sendTelegramMessage } from '../api/_lib/telegram.js';

let passed = 0;
async function test(name, fn) { try { await fn(); passed += 1; console.log(`✓ ${name}`); } catch (error) { console.error(`✗ ${name}`); throw error; } }
function fakeDb() {
  const records = new Map();
  const refs = new Map();
  const getRef = id => {
    if (!refs.has(id)) refs.set(id, { id, update: async fields => records.set(id, { ...records.get(id), ...fields }) });
    return refs.get(id);
  };
  return {
    records,
    collection: () => ({ doc: getRef }),
    runTransaction: async fn => fn({
      get: async ref => ({ exists: records.has(ref.id), data: () => records.get(ref.id) }),
      set: (ref, value) => records.set(ref.id, value),
      update: (ref, fields) => records.set(ref.id, { ...records.get(ref.id), ...fields }),
    }),
  };
}
await test('outbox id is deterministic and HTML is escaped', () => {
  assert.equal(emailId('a/b?c'), 'a_b_c');
  const html = emailHtml('<script>', 'Hello <script>');
  assert(!html.includes('<script>'));
  assert(html.includes('&lt;script&gt;'));
});
await test('receipt totals and escaped customer name are rendered', () => {
  const { htmlContent } = orderReceiptEmail({ id: 'doc', orderId: 'HS-2026-000001', delivery: { fullName: '<script>', deliveryMethod: 'COLLECTION' }, items: [{ name: 'Heel', size: '38', quantity: 2, unitPrice: 1000, lineTotal: 2000 }], subtotal: 2000, discount: 100, promoCode: 'SAVE', deliveryFee: 100, total: 2000 }, 'PAID');
  assert(htmlContent.includes('KSh 2,000'));
  assert(htmlContent.includes('KSh -100'));
  assert(!htmlContent.includes('<script>'));
});
await test('outbox is idempotent and a failed delivery returns to PENDING', async () => {
  const db = fakeDb();
  const key = 'same/key';
  await db.runTransaction(tx => queueEmail(tx, db, { key, purpose: 'hello', to: 'customer@example.com', subject: 'One', htmlContent: '<p>One</p>' }));
  await db.runTransaction(tx => queueEmail(tx, db, { key, purpose: 'hello', to: 'customer@example.com', subject: 'Two', htmlContent: '<p>Two</p>' }));
  assert.equal(db.records.size, 1);
  const result = await deliverQueuedEmail(db, emailId(key), { cfg: { apiKey: 'key', senders: { hello: 'hello@example.com' }, senderName: 'HerStep', replyTo: '' }, fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(result.sent, false);
  assert.equal(db.records.get(emailId(key)).status, 'PENDING');
  assert.equal(db.records.get(emailId(key)).lastError, 'Delivery attempt failed.');
});
await test('missing email configuration skips silently', async () => {
  const result = await deliverQueuedEmailInline({}, 'key', { cfg: { apiKey: '', senders: {}, senderName: '', replyTo: '' } });
  assert.equal(result.skipped, true);
});
await test('telegram never throws on network errors', async () => {
  const sent = await sendTelegramMessage('test', { cfg: { token: 'x', chatId: 'y' }, fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(sent, false);
});
console.log(`\n${passed} notification tests passed`);
