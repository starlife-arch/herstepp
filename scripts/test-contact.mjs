// Offline test suite for the Contact form (POST /api/contact + admin inbox).
// NO network, NO Firebase credentials. Runs the REAL core logic
// (api/_lib/routes/contact-core.js) against the strict fake Firestore, plus
// the REAL HTTP wrappers (contact.js / admin-contact.js) with firebase-admin
// and @vercel/functions stubbed through a loader hook — exactly like
// scripts/test-order-core.mjs stubs the provider.
//
// Regression guarded here first: reserveRateSlot used to tx.get() AFTER a
// tx.set(), which real Firestore rejects ("all reads before all writes") and
// made EVERY production submission answer 500 "We could not complete that
// request." The wrapper tests below run the genuine handler end-to-end.
//
// Run with: npm test  (uses --import scripts/contact-stub.mjs, see package.json)
import assert from 'node:assert/strict';
import { createFakeDb } from '../api/_lib/fake-firestore.js';
import { emailId } from '../api/_lib/email-service.js';
import {
  formatMessageId,
  hashIp,
  parseContactInput,
  submitContactMessage,
  listContactMessages,
  updateContactStatus,
  replyContactMessage,
} from '../api/_lib/routes/contact-core.js';

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (err) {
    failures.push([name, err]);
    console.log(`  ✗ ${name}\n      ${err.message}`);
  }
}

function newDb() {
  return createFakeDb();
}
function seedMsg(db, id, data) {
  db.__seed('contactMessages', id, {
    messageId: data.messageId || `MSG-${id.slice(-6).padStart(6, '0')}`,
    name: 'Wanjiku Kamau',
    email: 'wanjiku@example.com',
    phone: '+254712345678',
    message: 'Hello, I love your shoes.',
    status: 'NEW',
    customerId: null,
    ipHash: 'hash-a',
    repliedAt: null,
    lastReply: null,
    createdAt: db.__serverTimestamp(),
    updatedAt: db.__serverTimestamp(),
    ...data,
  });
}

const VALID_BODY = {
  name: ' Wanjiku   Kamau ',
  email: 'Wanjiku@Example.COM ',
  phone: '0712 345 678',
  message: '  Hello, I love your shoes!  ',
};

// ---------------------------------------------------------------------------
console.log('\ncontact-core validation');
// ---------------------------------------------------------------------------
await test('valid input is trimmed, collapsed and lowercased', () => {
  const parsed = parseContactInput({ ...VALID_BODY });
  assert.equal(parsed.honeypot, false);
  assert.equal(parsed.name, 'Wanjiku Kamau');
  assert.equal(parsed.email, 'wanjiku@example.com');
  assert.equal(parsed.phone, '+254712345678');
  assert.equal(parsed.message, 'Hello, I love your shoes!');
});

await test('unknown fields are rejected', () => {
  assert.throws(() => parseContactInput({ ...VALID_BODY, role: 'ADMIN' }), /Unknown contact field/i);
});

await test('invalid email rejected', () => {
  assert.throws(() => parseContactInput({ ...VALID_BODY, email: 'not-an-email' }), /valid email/i);
});

await test('short message rejected (5..2000)', () => {
  assert.throws(() => parseContactInput({ ...VALID_BODY, message: 'hey' }), /5 to 2000/i);
});

await test('over-long message rejected', () => {
  assert.throws(() => parseContactInput({ ...VALID_BODY, message: 'x'.repeat(2001) }), /5 to 2000/i);
});

await test('short name rejected (2..80)', () => {
  assert.throws(() => parseContactInput({ ...VALID_BODY, name: 'A' }), /2 to 80/i);
});

await test('phone is optional; invalid phone rejected', () => {
  const noPhone = parseContactInput({ name: 'Ann B', email: 'ann@example.com', message: 'Hello there' });
  assert.equal(noPhone.phone, null);
  assert.throws(() => parseContactInput({ ...VALID_BODY, phone: '12345' }), /Kenyan phone/i);
});

await test('honeypot filled -> { honeypot: true }, nothing else', () => {
  const parsed = parseContactInput({ ...VALID_BODY, website: 'http://spam.example' });
  assert.deepEqual(parsed, { honeypot: true });
});

await test('formatMessageId pads the counter', () => {
  assert.equal(formatMessageId(1), 'MSG-000001');
  assert.equal(formatMessageId(12), 'MSG-000012');
});

await test('hashIp is deterministic, truncated, and never contains the raw IP', () => {
  const h = hashIp('41.90.73.10', 'proj-x');
  assert.match(h, /^[0-9a-f]{32}$/);
  assert.equal(h, hashIp('41.90.73.10', 'proj-x'));
  assert.notEqual(h, hashIp('41.90.73.11', 'proj-x'));
  assert.ok(!h.includes('41.90.73.10'));
});

// ---------------------------------------------------------------------------
console.log('\nsubmitContactMessage (real transaction order: reads before writes)');
// ---------------------------------------------------------------------------
await test('valid message stored with a counter id; rate doc keyed by ipHash only', async () => {
  const db = newDb();
  const res = await submitContactMessage({ db, body: VALID_BODY, ipHash: 'hash-a', uid: null, now: 1_700_000_000_000 });
  assert.equal(res.ok, true);
  assert.equal(res.messageId, 'MSG-000001');
  const msgs = db.__list('contactMessages');
  assert.equal(msgs.length, 1);
  const doc = msgs[0].data;
  assert.equal(doc.messageId, 'MSG-000001');
  assert.equal(doc.name, 'Wanjiku Kamau');
  assert.equal(doc.email, 'wanjiku@example.com');
  assert.equal(doc.phone, '+254712345678');
  assert.equal(doc.status, 'NEW');
  assert.equal(doc.customerId, null);
  assert.equal(doc.ipHash, 'hash-a');
  assert.ok(doc.createdAt && doc.createdAt.__serverTs, 'createdAt must be the serverTimestamp sentinel');
  // RAW IP must appear nowhere in the database.
  assert.ok(!JSON.stringify(db.__list('contactMessages')).includes('41.90.73.10'));
  const rate = db.__doc('rateLimits', 'contact_hash-a');
  assert.ok(rate, 'rateLimits/contact_<ipHash> reserved in the same transaction');
  assert.equal(rate.hourCount, 1);
  assert.equal(rate.dayCount, 1);
  assert.equal(db.__doc('counters', 'contactMessages').sequence, 1);
});

await test('second submission increments the counter -> MSG-000002', async () => {
  const db = newDb();
  const t0 = 1_700_000_000_000;
  await submitContactMessage({ db, body: VALID_BODY, ipHash: 'hash-a', uid: null, now: t0 });
  const res = await submitContactMessage({ db, body: VALID_BODY, ipHash: 'hash-a', uid: null, now: t0 + 1000 });
  assert.equal(res.messageId, 'MSG-000002');
});

await test('signed-in submission attaches the uid as customerId', async () => {
  const db = newDb();
  await submitContactMessage({ db, body: VALID_BODY, ipHash: 'hash-b', uid: 'user-9' });
  assert.equal(db.__list('contactMessages')[0].data.customerId, 'user-9');
});

await test('honeypot stores NOTHING and sends nothing', async () => {
  const db = newDb();
  let telegramCalls = 0;
  const res = await submitContactMessage({
    db, body: { ...VALID_BODY, website: 'http://spam' }, ipHash: 'hash-c', uid: null,
    telegramText: 'x', sendTelegram: async () => { telegramCalls += 1; return true; },
  });
  assert.deepEqual(res, { ok: true, honeypot: true });
  assert.equal(db.__list('contactMessages').length, 0);
  assert.equal(db.__list('emailOutbox').length, 0);
  assert.equal(db.__list('rateLimits').length, 0);
  assert.equal(telegramCalls, 0);
});

await test('auto-reply queued inside the SAME transaction with key <id>-CONTACT-RECEIVED, purpose support', async () => {
  const db = newDb();
  const res = await submitContactMessage({ db, body: VALID_BODY, ipHash: 'hash-d', uid: null });
  const outbox = db.__list('emailOutbox');
  assert.equal(outbox.length, 1);
  const email = outbox[0].data;
  assert.equal(email.key, `${res.id}-CONTACT-RECEIVED`);
  assert.equal(outbox[0].id, emailId(`${res.id}-CONTACT-RECEIVED`));
  assert.equal(email.purpose, 'support');
  assert.equal(email.to, 'wanjiku@example.com');
  assert.equal(email.attachInvoiceFor ?? null, null);
  assert.match(email.subject, /received your message/i);
  assert.ok(!/<a\s/i.test(email.htmlContent), 'auto-reply must contain NO links');
});

await test('rate limit: 3 per hour then 429 (retryAfterSeconds set, nothing stored)', async () => {
  const db = newDb();
  const t0 = 1_700_000_000_000;
  for (let i = 1; i <= 3; i += 1) {
    const r = await submitContactMessage({ db, body: VALID_BODY, ipHash: 'hash-e', uid: null, now: t0 + i * 1000 });
    assert.equal(r.messageId, `MSG-00000${i}`);
  }
  await assert.rejects(
    submitContactMessage({ db, body: VALID_BODY, ipHash: 'hash-e', uid: null, now: t0 + 4000 }),
    err => {
      assert.equal(err.statusCode, 429);
      assert.match(err.message, /Too many messages/i);
      assert.ok(Number.isFinite(err.retryAfterSeconds) && err.retryAfterSeconds > 0);
      return true;
    },
  );
  // The rejected attempt stored nothing new.
  assert.equal(db.__list('contactMessages').length, 3);
  assert.equal(db.__doc('rateLimits', 'contact_hash-e').hourCount, 3);
});

await test('day limit: 10 per day even across fresh hour windows', async () => {
  const db = newDb();
  const t0 = 1_700_000_000_000;
  for (let i = 0; i < 10; i += 1) {
    // Each call lands in a NEW hour window (2h apart) so only the day cap can stop it.
    await submitContactMessage({ db, body: VALID_BODY, ipHash: 'hash-f', uid: null, now: t0 + i * 2 * 3_600_000 });
  }
  await assert.rejects(
    submitContactMessage({ db, body: VALID_BODY, ipHash: 'hash-f', uid: null, now: t0 + 10 * 2 * 3_600_000 }),
    err => err.statusCode === 429,
  );
});

await test('different ipHash gets its own budget', async () => {
  const db = newDb();
  for (let i = 0; i < 3; i += 1) {
    await submitContactMessage({ db, body: VALID_BODY, ipHash: 'hash-g', uid: null });
  }
  const r = await submitContactMessage({ db, body: VALID_BODY, ipHash: 'hash-h', uid: null });
  assert.equal(r.ok, true);
});

await test('hour window resets after an hour; day window still counts', async () => {
  const db = newDb();
  const t0 = 1_700_000_000_000;
  for (let i = 0; i < 3; i += 1) {
    await submitContactMessage({ db, body: VALID_BODY, ipHash: 'hash-i', uid: null, now: t0 + i * 1000 });
  }
  // One hour later the hour count resets, day count continues from 3.
  const r = await submitContactMessage({ db, body: VALID_BODY, ipHash: 'hash-i', uid: null, now: t0 + 3_600_001 });
  assert.equal(r.ok, true);
  const rate = db.__doc('rateLimits', 'contact_hash-i');
  assert.equal(rate.hourCount, 1);
  assert.equal(rate.dayCount, 4);
});

await test('Telegram failure NEVER fails the request', async () => {
  const db = newDb();
  const res = await submitContactMessage({
    db, body: VALID_BODY, ipHash: 'hash-j', uid: null, telegramText: 'x',
    sendTelegram: async () => { throw new Error('telegram down'); },
  });
  assert.equal(res.ok, true);
  assert.equal(db.__list('contactMessages').length, 1);
});

await test('sync Telegram throw also swallowed', async () => {
  const db = newDb();
  const res = await submitContactMessage({
    db, body: VALID_BODY, ipHash: 'hash-k', uid: null, telegramText: 'x',
    sendTelegram: () => { throw new Error('boom'); },
  });
  assert.equal(res.ok, true);
});

await test('email delivery failure NEVER fails the request (outbox stays PENDING)', async () => {
  const db = newDb();
  process.env.BREVO_API_KEY = 'test-key';
  process.env.BREVO_SENDER_SUPPORT = 'support@herstepcollection.shop';
  globalThis.fetch = async () => { throw new Error('brevo down'); };
  try {
    const res = await submitContactMessage({ db, body: VALID_BODY, ipHash: 'hash-l', uid: null });
    assert.equal(res.ok, true);
    const outbox = db.__list('emailOutbox');
    assert.equal(outbox.length, 1);
    assert.equal(outbox[0].data.status, 'PENDING', 'failed delivery returns to PENDING for retry');
  } finally {
    delete process.env.BREVO_API_KEY;
    delete process.env.BREVO_SENDER_SUPPORT;
    delete globalThis.fetch;
  }
});

await test('successful delivery marks the auto-reply SENT', async () => {
  const db = newDb();
  process.env.BREVO_API_KEY = 'test-key';
  process.env.BREVO_SENDER_SUPPORT = 'support@herstepcollection.shop';
  const sentBodies = [];
  globalThis.fetch = async (_url, init) => {
    sentBodies.push(JSON.parse(init.body));
    return { ok: true, status: 200, json: async () => ({ messageId: 1 }) };
  };
  try {
    const res = await submitContactMessage({ db, body: VALID_BODY, ipHash: 'hash-m', uid: null });
    assert.equal(res.ok, true);
    assert.equal(db.__list('emailOutbox')[0].data.status, 'SENT');
    assert.equal(sentBodies.length, 1);
    assert.equal(sentBodies[0].to[0].email, 'wanjiku@example.com');
  } finally {
    delete process.env.BREVO_API_KEY;
    delete process.env.BREVO_SENDER_SUPPORT;
    delete globalThis.fetch;
  }
});

// ---------------------------------------------------------------------------
console.log('\nadmin list / status / reply (core)');
// ---------------------------------------------------------------------------
await test('list is newest first, filters by status, caps at limit with cursor, counts unread', async () => {
  const db = newDb();
  for (let i = 1; i <= 5; i += 1) {
    seedMsg(db, `m${i}`, { messageId: `MSG-00000${i}`, status: i === 1 ? 'READ' : 'NEW', createdAt: db.__serverTimestamp() });
  }
  const page1 = await listContactMessages({ db, status: null, cursor: null, limit: 3 });
  assert.equal(page1.messages.length, 3);
  assert.equal(page1.unread, 4, 'unread counts every NEW doc, not just this page');
  // Newest first == highest serverTimestamp sentinel == MSG-000005 first.
  assert.equal(page1.messages[0].messageId, 'MSG-000005');
  assert.equal(page1.messages[2].messageId, 'MSG-000003');
  assert.ok(page1.nextCursor, 'cursor returned when the page is full');
  const page2 = await listContactMessages({ db, status: null, cursor: page1.nextCursor, limit: 3 });
  assert.equal(page2.messages.length, 2);
  assert.equal(page2.messages[0].messageId, 'MSG-000002');
  assert.equal(page2.nextCursor, null);
  const readOnly = await listContactMessages({ db, status: 'READ', cursor: null, limit: 100 });
  assert.equal(readOnly.messages.length, 1);
  assert.equal(readOnly.messages[0].messageId, 'MSG-000001');
  await assert.rejects(listContactMessages({ db, status: 'BOGUS', cursor: null }), /Unknown message status/i);
});

await test('status moves forward only; ARCHIVED is final; audit log written', async () => {
  const db = newDb();
  seedMsg(db, 'm1', { status: 'NEW' });
  const admin = { uid: 'admin-1', email: 'a@example.com', displayName: 'Ada' };
  await updateContactStatus({ db, admin, id: 'm1', status: 'READ' });
  assert.equal(db.__doc('contactMessages', 'm1').status, 'READ');
  await updateContactStatus({ db, admin, id: 'm1', status: 'REPLIED' });
  assert.equal(db.__doc('contactMessages', 'm1').status, 'REPLIED');
  await assert.rejects(updateContactStatus({ db, admin, id: 'm1', status: 'NEW' }), err => err.statusCode === 409);
  await updateContactStatus({ db, admin, id: 'm1', status: 'ARCHIVED' });
  assert.equal(db.__doc('contactMessages', 'm1').status, 'ARCHIVED');
  await assert.rejects(updateContactStatus({ db, admin, id: 'm1', status: 'READ' }), /Archived/i);
  await assert.rejects(updateContactStatus({ db, admin, id: 'missing', status: 'READ' }), err => err.statusCode === 404);
  const audits = db.__list('auditLogs');
  assert.equal(audits.length, 3);
  assert.equal(audits[0].data.action, 'CONTACT_STATUS');
  assert.equal(audits[0].data.previous, 'NEW');
  assert.equal(audits[0].data.next, 'READ');
  assert.equal(audits[0].data.adminId, 'admin-1');
});

await test('reply escapes HTML, sets REPLIED, stores lastReply/repliedAt, audits CONTACT_REPLIED, queues support email', async () => {
  const db = newDb();
  seedMsg(db, 'm1', { status: 'READ' });
  const admin = { uid: 'admin-1', email: 'a@example.com', displayName: 'Ada' };
  const evil = 'Hi <script>alert("xss")</script> & more';
  const res = await replyContactMessage({ db, admin, id: 'm1', body: evil });
  assert.equal(res.ok, true);
  const doc = db.__doc('contactMessages', 'm1');
  assert.equal(doc.status, 'REPLIED');
  assert.equal(doc.lastReply, evil.trim());
  assert.ok(doc.repliedAt, 'repliedAt uses the server timestamp');
  const outbox = db.__list('emailOutbox');
  assert.equal(outbox.length, 1);
  const email = outbox[0].data;
  assert.equal(email.purpose, 'support');
  assert.equal(email.to, 'wanjiku@example.com');
  assert.equal(email.subject, 'Re: your message to HerStep Collection');
  assert.ok(!email.htmlContent.includes('<script>'), 'reply body must be escaped');
  assert.ok(email.htmlContent.includes('&lt;script&gt;'));
  const audits = db.__list('auditLogs');
  assert.equal(audits.length, 1);
  assert.equal(audits[0].data.action, 'CONTACT_REPLIED');
  assert.equal(audits[0].data.previous, 'READ');
  assert.equal(audits[0].data.next, 'REPLIED');
});

await test('reply validates body (1..3000) and refuses archived / missing', async () => {
  const db = newDb();
  seedMsg(db, 'm1', { status: 'NEW' });
  seedMsg(db, 'arch', { status: 'ARCHIVED' });
  const admin = { uid: 'admin-1' };
  await assert.rejects(replyContactMessage({ db, admin, id: 'm1', body: '' }), /1 to 3000/i);
  await assert.rejects(replyContactMessage({ db, admin, id: 'm1', body: 'x'.repeat(3001) }), /1 to 3000/i);
  await assert.rejects(replyContactMessage({ db, admin, id: 'arch', body: 'hello' }), /Archived/i);
  await assert.rejects(replyContactMessage({ db, admin, id: 'nope', body: 'hello' }), err => err.statusCode === 404);
  assert.equal(db.__list('emailOutbox').length, 0);
});

await test('reply email failure does not fail the admin call', async () => {
  const db = newDb();
  seedMsg(db, 'm1', { status: 'NEW' });
  process.env.BREVO_API_KEY = 'test-key';
  process.env.BREVO_SENDER_SUPPORT = 'support@herstepcollection.shop';
  globalThis.fetch = async () => { throw new Error('brevo down'); };
  try {
    const res = await replyContactMessage({ db, admin: { uid: 'admin-1' }, id: 'm1', body: 'Thanks!' });
    assert.equal(res.ok, true);
    assert.equal(res.sent, false);
    assert.equal(db.__doc('contactMessages', 'm1').status, 'REPLIED');
  } finally {
    delete process.env.BREVO_API_KEY;
    delete process.env.BREVO_SENDER_SUPPORT;
    delete globalThis.fetch;
  }
});

// ---------------------------------------------------------------------------
// Real HTTP wrappers: load api/users.js + api/admin.js with firebase-admin and
// @vercel/functions stubbed through scripts/contact-stub.mjs (a module that
// registers itself on globalThis.__contactStubs before anything imports). This
// proves the exact production wiring — including the read-before-write
// ordering that caused the live 500.
// ---------------------------------------------------------------------------
const STUBS = globalThis.__contactStubs;
assert.ok(STUBS, 'test-contact.mjs must run with --import scripts/contact-stub.mjs');
STUBS.reset();

const usersMod = await import('../api/users.js');
const adminMod = await import('../api/admin.js');

function makeRes() {
  const res = { statusCode: 200, body: null, headers: {} };
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (payload) => { res.body = payload; return res; };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  return res;
}

console.log('\nHTTP wrappers (production wiring, stubbed auth/db)');
// ---------------------------------------------------------------------------
await test('POST /api/contact valid submission answers 200 {ok:true,messageId} (the live 500 regression)', async () => {
  const req = { method: 'POST', body: VALID_BODY, headers: {}, ip: '41.90.73.10' };
  const res = makeRes();
  await usersMod.default(req, res);
  await Promise.allSettled(STUBS.pendingWork.splice(0));
  assert.equal(res.statusCode, 200, `expected 200, got ${res.statusCode}: ${JSON.stringify(res.body)}`);
  assert.equal(res.body.ok, true);
  assert.match(res.body.messageId, /^MSG-\d{6}$/);
});

await test('POST /api/contact stores the message, rate doc by hash only (no raw IP anywhere)', async () => {
  const db = STUBS.db;
  const msgs = db.__list('contactMessages');
  assert.ok(msgs.length >= 1);
  const doc = msgs[0].data;
  assert.match(doc.ipHash, /^[0-9a-f]{32}$/);
  const dump = JSON.stringify([...db.__list('contactMessages'), ...db.__list('rateLimits')]);
  assert.ok(!dump.includes('41.90.73.10'), 'raw IP must never be stored');
  assert.ok(db.__list('rateLimits').every(r => r.id.startsWith('contact_')));
});

await test('signed-in POST /api/contact attaches the uid from the Bearer token', async () => {
  const res = makeRes();
  await usersMod.default({ method: 'POST', body: VALID_BODY, headers: { authorization: 'Bearer customer-1' }, ip: '5.5.5.1' }, res);
  assert.equal(res.statusCode, 200);
  const last = STUBS.db.__list('contactMessages').at(-1).data;
  assert.equal(last.customerId, 'customer-1');
});

await test('invalid token still submits anonymously (public form)', async () => {
  const res = makeRes();
  await usersMod.default({ method: 'POST', body: VALID_BODY, headers: { authorization: 'Bearer bad' }, ip: '5.5.5.2' }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(STUBS.db.__list('contactMessages').at(-1).data.customerId, null);
});

await test('POST /api/contact invalid email answers 400 with the real message', async () => {
  const res = makeRes();
  await usersMod.default({ method: 'POST', body: { ...VALID_BODY, email: 'nope' }, headers: {}, ip: '1.2.3.4' }, res);
  assert.equal(res.statusCode, 400);
  assert.match(res.body.error, /valid email/i);
});

await test('POST /api/contact honeypot answers 200 without a messageId', async () => {
  const before = STUBS.db.__list('contactMessages').length;
  const res = makeRes();
  await usersMod.default({ method: 'POST', body: { ...VALID_BODY, website: 'http://spam' }, headers: {}, ip: '8.8.8.8' }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
  assert.equal(STUBS.db.__list('contactMessages').length, before, 'honeypot stores nothing');
});

await test('GET /api/admin/contact-messages requires admin (401 anonymous, 403 CUSTOMER, 200 ADMIN)', async () => {
  const anon = makeRes();
  await adminMod.default({ method: 'GET', query: { route: 'contact-messages' }, headers: {} }, anon);
  assert.equal(anon.statusCode, 401);
  const cust = makeRes();
  await adminMod.default({ method: 'GET', query: { route: 'contact-messages' }, headers: { authorization: 'Bearer customer-1' } }, cust);
  assert.equal(cust.statusCode, 403);
  const ok = makeRes();
  await adminMod.default({ method: 'GET', query: { route: 'contact-messages' }, headers: { authorization: 'Bearer admin-1' } }, ok);
  assert.equal(ok.statusCode, 200);
  assert.ok(Array.isArray(ok.body.messages));
  assert.ok(Number.isFinite(ok.body.unread));
  // Newest first through the real wrapper too.
  if (ok.body.messages.length > 1) {
    const created = ok.body.messages.map(m => m.createdAt.__serverTs ? m.createdAt.n : 0);
    assert.deepEqual(created, [...created].sort((a, b) => b - a));
  }
});

await test('PATCH status moves NEW->READ through the wrapper (and rejects non-admins)', async () => {
  const cust = makeRes();
  await adminMod.default({ method: 'PATCH', query: { route: 'contact-messages/status' }, body: { id: 'x', status: 'READ' }, headers: { authorization: 'Bearer customer-1' } }, cust);
  assert.equal(cust.statusCode, 403);
  // Create a message via the public endpoint, then move it as admin.
  const post = makeRes();
  await usersMod.default({ method: 'POST', body: VALID_BODY, headers: {}, ip: '7.7.7.1' }, post);
  const created = STUBS.db.__list('contactMessages').at(-1);
  const patch = makeRes();
  await adminMod.default({ method: 'PATCH', query: { route: 'contact-messages/status' }, body: { id: created.id, status: 'READ' }, headers: { authorization: 'Bearer admin-1' } }, patch);
  assert.equal(patch.statusCode, 200);
  assert.equal(STUBS.db.__doc('contactMessages', created.id).status, 'READ');
});

await test('POST reply through the wrapper sends the support email, escapes HTML and sets REPLIED', async () => {
  const created = STUBS.db.__list('contactMessages').at(-1);
  const reply = makeRes();
  await adminMod.default({
    method: 'POST', query: { route: 'contact-messages/reply' },
    body: { id: created.id, body: 'Thanks <b>you</b>!' },
    headers: { authorization: 'Bearer admin-1' },
  }, reply);
  assert.equal(reply.statusCode, 200);
  assert.equal(reply.body.ok, true);
  await Promise.allSettled(STUBS.pendingWork.splice(0));
  assert.equal(STUBS.db.__doc('contactMessages', created.id).status, 'REPLIED');
  const emails = STUBS.db.__list('emailOutbox').filter(e => e.data.key.includes('-CONTACT-REPLY-'));
  assert.equal(emails.length, 1);
  assert.ok(!emails[0].data.htmlContent.includes('<b>you</b>'), 'reply body must be escaped');
  assert.ok(emails[0].data.htmlContent.includes('&lt;b&gt;you&lt;/b&gt;'));
  const audits = STUBS.db.__list('auditLogs').filter(a => a.data.action === 'CONTACT_REPLIED');
  assert.equal(audits.length, 1);
});

await test('wrapper: Telegram/email outages NEVER turn into a 5xx', async () => {
  process.env.BREVO_API_KEY = 'test-key';
  process.env.BREVO_SENDER_SUPPORT = 'support@herstepcollection.shop';
  globalThis.fetch = async () => { throw new Error('brevo down'); };
  try {
    const res = makeRes();
    await usersMod.default({ method: 'POST', body: VALID_BODY, headers: {}, ip: '6.6.6.1' }, res);
    await Promise.allSettled(STUBS.pendingWork.splice(0));
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.ok, true);
  } finally {
    delete process.env.BREVO_API_KEY;
    delete process.env.BREVO_SENDER_SUPPORT;
    delete globalThis.fetch;
  }
});

// ---------------------------------------------------------------------------
console.log(`\n${passed} passed, ${failures.length} failed`);
if (failures.length) {
  for (const [name, err] of failures) console.error(`FAIL: ${name}\n${err.stack}`);
  process.exit(1);
}
