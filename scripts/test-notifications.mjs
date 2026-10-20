import assert from 'node:assert/strict';
import { emailId, queueEmail, deliverQueuedEmail, deliverQueuedEmailInline } from '../api/_lib/email-service.js';
import { emailHtml, orderReceiptEmail, marketplaceInvoiceEmail } from '../api/_lib/email-templates.js';
import { queueMarketplaceSaleInvoices, queuePaymentEmail } from '../api/_lib/notify.js';
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
await test('marketplace invoices identify buyer and seller and contain only seller-owned lines', () => {
  const order = {
    orderId: 'HS-2026-000123', customerEmail: 'buyer@example.com', customerName: 'Buyer Name',
    customerPhone: '+254700000001', delivery: { fullName: 'Buyer Name', phone: '+254700000001' },
    items: [
      { sellerId: 'seller-one', sellerSnapshot: { sellerId: 'seller-one' }, name: 'Blue Bag', size: 'One Size', quantity: 1, unitPrice: 1200, lineTotal: 1200 },
      { sellerId: 'seller-two', sellerSnapshot: { sellerId: 'seller-two' }, name: 'Gold Necklace', size: 'One Size', quantity: 2, unitPrice: 500, lineTotal: 1000 },
    ],
  };
  const first = marketplaceInvoiceEmail({
    order, seller: { businessName: 'Blue Boutique', email: 'blue@example.com' },
    items: [order.items[0]], invoiceNumber: 'MKT-123-ONE', receiptNumber: 'QWE123',
  });
  assert(first.subject.includes('Blue Boutique'));
  assert(first.htmlContent.includes('buyer@example.com'));
  assert(first.htmlContent.includes('Blue Boutique'));
  assert(first.htmlContent.includes('QWE123'));
  assert(first.htmlContent.includes('Invoice date:'));
  assert(first.htmlContent.includes('Fulfilment:'));
  assert(first.htmlContent.includes('Jerry House pickup point and first-party delivery charges do not apply'));
  assert(first.htmlContent.includes('Blue Bag'));
  assert(!first.htmlContent.includes('Gold Necklace'));
  assert(first.htmlContent.includes('HerStep Collection provides the marketplace'));
  assert(first.htmlContent.includes('HERSTEP MARKETPLACE'));
  assert(!first.htmlContent.includes('<script>'));
});
await test('marketplace payment receipt does not promise a HerStep seller invoice', () => {
  const db = fakeDb();
  const keys = [];
  const tx = { set: (ref, value) => db.records.set(ref.id, value) };
  const order = {
    orderId: 'HS-2026-000124', customerEmail: 'buyer@example.com', customerName: 'Buyer',
    subtotal: 1200, deliveryFee: 0, discount: 0, total: 1200,
    items: [{ sellerId: 'seller-one', name: 'Blue Bag', size: 'One Size', quantity: 1, unitPrice: 1200, lineTotal: 1200 }],
  };
  keys.push(...queuePaymentEmail(tx, db, { orderDocumentId: 'order-marketplace-123', order, status: 'PAID', receiptNumber: 'QWE123' }));
  assert.equal(keys.length, 1);
  assert(!keys.some(key => key.endsWith('-INVOICE')));
  const receipt = [...db.records.values()][0];
  assert(receipt.htmlContent.includes('Seller-specific invoices for marketplace items are sent separately'));
  assert(receipt.htmlContent.includes('The seller will coordinate delivery or pickup directly'));
  assert(!receipt.htmlContent.includes('Collection at Juja Town, Jerry House'));
  assert(!receipt.htmlContent.includes('Your invoice is in a separate email from invoices@'));
});
await test('marketplace sale queues one buyer and one seller invoice per seller, without SMS', () => {
  const db = fakeDb();
  const writes = [];
  const tx = { set: (ref, value) => { writes.push({ id: ref.id, ...value }); db.records.set(ref.id, value); } };
  queueMarketplaceSaleInvoices(tx, db, {
    orderDocumentId: 'order-doc-12345678',
    order: {
      orderId: 'HS-2026-000123', customerEmail: 'buyer@example.com', customerName: 'Buyer Name',
      items: [
        { sellerId: 'seller-one', name: 'Blue Bag', quantity: 1, unitPrice: 1200, lineTotal: 1200 },
        { sellerId: 'seller-two', name: 'Gold Necklace', quantity: 2, unitPrice: 500, lineTotal: 1000 },
      ],
    },
    sellerDetails: new Map([
      ['seller-one', { email: 'blue@example.com', businessName: 'Blue Boutique' }],
      ['seller-two', { email: 'gold@example.com', businessName: 'Gold House' }],
    ]),
    receiptNumber: 'QWE123',
  });
  assert.equal(writes.length, 4);
  assert.deepEqual(writes.map(row => row.to).sort(), ['blue@example.com', 'buyer@example.com', 'buyer@example.com', 'gold@example.com']);
  assert(writes.every(row => row.purpose === 'orders'));
  assert(writes.every(row => !row.key.includes('SMS')));
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
