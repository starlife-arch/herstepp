// Offline test suite for api/_lib/routes/email-verify-core.js — NO network,
// NO Firebase credentials. Runs the real send/confirm logic against the strict
// in-memory fake Firestore (api/_lib/fake-firestore.js).
//
// The only deviation from production wiring is deps.generateCode (a documented
// TEST SEAM in email-verify-core.js): the suite injects a known 6-digit code so
// it can check the stored HMAC and drive every confirm branch. Everything else
// — rate limits, hashing, HKDF key derivation, timing-safe compare, the outbox
// queue inside the transaction — is the genuine route code.
//
// Run with: npm test
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createFakeDb } from '../api/_lib/fake-firestore.js';
import { emailId } from '../api/_lib/email-service.js';
import { verificationCodeEmail } from '../api/_lib/email-templates.js';
import {
  deriveVerifyKey,
  verifyKey,
  hashCode,
  maskEmail,
  sendVerifyCode,
  confirmVerifyCode,
  CODE_TTL_MS,
  RESEND_COOLDOWN_MS,
  MAX_HOURLY_SENDS,
  MAX_ATTEMPTS,
  NOT_CONFIGURED_MESSAGE,
} from '../api/_lib/routes/email-verify-core.js';

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

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const UID = 'user-1';
const EMAIL = 'jane@example.com';
const TEST_KEY = crypto.randomBytes(32); // stands in for the derived key

// Console spy: records every log/warn/error argument so we can PROVE the plain
// code never leaks into logs, and captures the final JSON of any object logged.
function spyConsole() {
  const original = {};
  const lines = [];
  for (const level of ['log', 'warn', 'error', 'info', 'debug']) {
    original[level] = console[level];
    console[level] = (...args) => {
      lines.push(args.map(a => (typeof a === 'string' ? a : safeJson(a))).join(' '));
    };
  }
  return {
    lines,
    restore() {
      for (const level of Object.keys(original)) console[level] = original[level];
    },
  };
}

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function makeDeps(db, overrides = {}) {
  const deliveredKeys = [];
  const marked = [];
  const waitUntilJobs = [];
  const deps = {
    db,
    now: Date.now(),
    verifyKey: () => TEST_KEY,
    verifySenderConfigured: () => true,
    deliverQueuedEmailInline: async (d, key) => {
      deliveredKeys.push(key);
      return { sent: true };
    },
    markAuthEmailVerified: async uid => {
      marked.push(uid);
      return true;
    },
    waitUntil: p => waitUntilJobs.push(p),
    ...overrides,
  };
  return { deps, deliveredKeys, marked, waitUntilJobs };
}

const user = extra => ({ uid: UID, email: EMAIL, email_verified: false, ...extra });

async function expectError(fn, pattern, statusCode) {
  let err = null;
  try {
    await fn();
  } catch (e) {
    err = e;
  }
  assert.ok(err, `expected an error matching ${pattern}`);
  assert.match(err.message, pattern);
  if (statusCode !== undefined) assert.equal(err.statusCode, statusCode, `status for "${err.message}"`);
  return err;
}

// Read the whole emailVerifications doc as a string for leak checks.
function dumpState(db) {
  return JSON.stringify({
    verifications: db.__list('emailVerifications'),
    users: db.__list('users'),
    outbox: db.__list('emailOutbox'),
  });
}

// ---------------------------------------------------------------------------
console.log('\nemail-verify: key derivation (HKDF, no VERIFY_CODE_SECRET)');
// ---------------------------------------------------------------------------
await test('hkdf derives a stable 32-byte key from the private key alone', () => {
  const privateKey = '-----BEGIN PRIVATE KEY-----\nMIIEvQTESTKEYMATERIAL\n-----END PRIVATE KEY-----\n';
  const k1 = deriveVerifyKey(privateKey);
  const k2 = deriveVerifyKey(privateKey);
  assert.ok(Buffer.isBuffer(k1), 'hkdfSync ArrayBuffer must be wrapped in a Buffer');
  assert.equal(k1.length, 32);
  assert.deepEqual([...k1], [...k2], 'derivation must be deterministic');
  // Matches the documented recipe exactly.
  const expected = Buffer.from(crypto.hkdfSync('sha256', privateKey.trim(), 'herstep-verify-salt', 'email-verify-code-v1', 32));
  assert.deepEqual([...k1], [...expected]);
});

await test('verifyKey works WITHOUT VERIFY_CODE_SECRET and prefers it when set', () => {
  const privateKey = '-----BEGIN PRIVATE KEY-----\nABC\n-----END PRIVATE KEY-----';
  const derived = verifyKey({ FIREBASE_ADMIN_PRIVATE_KEY: privateKey });
  assert.ok(Buffer.isBuffer(derived) && derived.length === 32);
  const explicit = verifyKey({ VERIFY_CODE_SECRET: 'a-secret-that-happens-to-be-set', FIREBASE_ADMIN_PRIVATE_KEY: privateKey });
  assert.deepEqual([...explicit], [...Buffer.from('a-secret-that-happens-to-be-set', 'utf8')]);
  assert.notDeepEqual([...derived], [...explicit]);
});

await test('missing private key AND missing secret answers 503, not a crash', () => {
  const err = (() => {
    try {
      verifyKey({});
      return null;
    } catch (e) {
      return e;
    }
  })();
  assert.ok(err);
  assert.equal(err.statusCode, 503);
  assert.equal(err.message, NOT_CONFIGURED_MESSAGE);
});

await test('maskEmail keeps the domain and hides the rest', () => {
  assert.equal(maskEmail('anna@gmail.com'), 'a***@gmail.com');
  assert.equal(maskEmail('x@y.co.ke'), 'x***@y.co.ke');
});

// ---------------------------------------------------------------------------
console.log('\nemail-verify: send');
// ---------------------------------------------------------------------------
await test('send stores ONLY the hash, queues the outbox inside the tx, returns masked email', async () => {
  const db = createFakeDb();
  db.__seed('users', UID, { uid: UID, email: EMAIL });
  const now = Date.now();
  const { deps, deliveredKeys, waitUntilJobs } = makeDeps(db, { now, generateCode: () => '123456' });

  const result = await sendVerifyCode(deps, user(), {});
  assert.deepEqual(result, {
    sent: true,
    maskedEmail: 'j***@example.com',
    expiresInSeconds: 600,
    resendInSeconds: 60,
  });

  const doc = db.__doc('emailVerifications', UID);
  assert.ok(doc, 'verification doc must exist');
  assert.equal(doc.codeHash, hashCode(TEST_KEY, UID, '123456'));
  assert.equal(doc.codeHash.length, 64, 'HMAC-SHA256 hex digest');
  assert.ok(!JSON.stringify(doc).includes('123456'), 'plain code must NOT be stored');
  assert.equal(doc.expiresAt, now + CODE_TTL_MS);
  assert.equal(doc.attempts, 0);
  assert.equal(doc.lastSentAt, now);
  assert.equal(doc.hourWindowStart, now);
  assert.equal(doc.hourCount, 1);
  assert.ok(Number.isFinite(doc.createdAt));

  // Outbox queued INSIDE the same transaction, deterministic key, purpose verify.
  const outbox = db.__list('emailOutbox');
  assert.equal(outbox.length, 1);
  assert.equal(outbox[0].id, emailId(`${UID}-VERIFY-${now}`));
  assert.equal(outbox[0].data.purpose, 'verify');
  assert.equal(outbox[0].data.to, EMAIL);
  assert.equal(outbox[0].data.status, 'PENDING');
  assert.ok(outbox[0].data.subject.includes('123456'), 'subject carries the code');

  // Delivered after the write via waitUntil, key matches the outbox doc.
  assert.deepEqual(deliveredKeys, [`${UID}-VERIFY-${now}`]);
  assert.equal(waitUntilJobs.length, 1);
  await Promise.all(waitUntilJobs);
});

await test('resend before 60 s rejected with 429 and secondsLeft', async () => {
  const db = createFakeDb();
  db.__seed('users', UID, { uid: UID, email: EMAIL });
  const t0 = 1_700_000_000_000;
  const first = makeDeps(db, { now: t0, generateCode: () => '111111' });
  await sendVerifyCode(first.deps, user(), {});

  const second = makeDeps(db, { now: t0 + 30_000, generateCode: () => '222222' });
  const err = await expectError(() => sendVerifyCode(second.deps, user(), {}), /wait|seconds/i, 429);
  assert.match(err.message, /30 seconds/);
  // Rejected request must not burn a code or queue another email.
  assert.equal(db.__doc('emailVerifications', UID).hourCount, 1);
  assert.equal(db.__list('emailOutbox').length, 1);

  // Exactly at 60 s the cooldown is over.
  const third = makeDeps(db, { now: t0 + RESEND_COOLDOWN_MS, generateCode: () => '333333' });
  const ok = await sendVerifyCode(third.deps, user(), {});
  assert.equal(ok.sent, true);
});

await test(`the ${MAX_HOURLY_SENDS + 1}th send within one hour rejected with 429`, async () => {
  const db = createFakeDb();
  db.__seed('users', UID, { uid: UID, email: EMAIL });
  const t0 = 1_700_000_000_000;
  for (let i = 0; i < MAX_HOURLY_SENDS; i += 1) {
    const { deps } = makeDeps(db, { now: t0 + i * 60_000, generateCode: () => `00000${i + 1}` });
    const res = await sendVerifyCode(deps, user(), {});
    assert.equal(res.sent, true, `send #${i + 1} should pass`);
  }
  const { deps } = makeDeps(db, { now: t0 + MAX_HOURLY_SENDS * 60_000, generateCode: () => '999999' });
  await expectError(() => sendVerifyCode(deps, user(), {}), /too many codes/i, 429);
  assert.equal(db.__doc('emailVerifications', UID).hourCount, MAX_HOURLY_SENDS);

  // After the window rolls over, sending works again and the counter resets.
  const after = makeDeps(db, { now: t0 + 60 * 60 * 1000 + 1, generateCode: () => '121212' });
  const res = await sendVerifyCode(after.deps, user(), {});
  assert.equal(res.sent, true);
  assert.equal(db.__doc('emailVerifications', UID).hourCount, 1);
});

await test('missing BREVO_SENDER_VERIFY answers 503 without storing anything', async () => {
  const db = createFakeDb();
  db.__seed('users', UID, { uid: UID, email: EMAIL });
  const { deps } = makeDeps(db, { verifySenderConfigured: () => false, generateCode: () => '123456' });
  await expectError(() => sendVerifyCode(deps, user(), {}), /not configured/i, 503);
  assert.equal(db.__doc('emailVerifications', UID), undefined, 'no half-sent code may be stored');
  assert.equal(db.__list('emailOutbox').length, 0);
});

await test('Google user gets verified:true without generating or emailing a code', async () => {
  const db = createFakeDb();
  db.__seed('users', UID, { uid: UID, email: EMAIL });
  const { deps, deliveredKeys } = makeDeps(db, {
    generateCode: () => {
      throw new Error('generateCode must never run for Google users');
    },
  });
  const res = await sendVerifyCode(deps, user({ firebase: { sign_in_provider: 'google.com' } }), {});
  assert.deepEqual(res, { verified: true });
  assert.equal(deliveredKeys.length, 0);
  assert.equal(db.__doc('emailVerifications', UID), undefined);
  assert.equal(db.__list('emailOutbox').length, 0);
});

await test('already-verified token short-circuits to verified:true', async () => {
  const db = createFakeDb();
  const { deps } = makeDeps(db);
  const res = await sendVerifyCode(deps, user({ email_verified: true }), {});
  assert.deepEqual(res, { verified: true });
  assert.equal(db.__list('emailOutbox').length, 0);
});

// ---------------------------------------------------------------------------
console.log('\nemail-verify: confirm');
// ---------------------------------------------------------------------------
async function seededWithCode(code, { now = Date.now(), attempts = 0, expired = false } = {}) {
  const db = createFakeDb();
  db.__seed('users', UID, { uid: UID, email: EMAIL });
  db.__seed('emailVerifications', UID, {
    codeHash: hashCode(TEST_KEY, UID, code),
    expiresAt: expired ? now - 1 : now + CODE_TTL_MS,
    attempts,
    lastSentAt: now,
    hourWindowStart: now,
    hourCount: 1,
    createdAt: now,
  });
  return { db, now };
}

await test('right code verifies: auth flag, profile flag, doc deleted', async () => {
  const { db, now } = await seededWithCode('246810');
  const { deps, marked, waitUntilJobs } = makeDeps(db, { now: now + 60_000 });
  const res = await confirmVerifyCode(deps, user(), { code: '246810' });
  assert.deepEqual(res, { verified: true });
  assert.deepEqual(marked, [UID], 'adminAuth.updateUser(uid,{emailVerified:true}) called once');
  assert.equal(db.__doc('users', UID).emailVerified, true);
  assert.ok(Number.isFinite(db.__doc('users', UID).updatedAt));
  assert.equal(db.__doc('emailVerifications', UID), undefined, 'code doc removed after success');
  await Promise.all(waitUntilJobs);
});

await test('wrong code increments attempts in a transaction and reports attempts left', async () => {
  const { db, now } = await seededWithCode('246810');
  const { deps, marked } = makeDeps(db, { now: now + 60_000 });
  const err = await expectError(() => confirmVerifyCode(deps, user(), { code: '000000' }), /incorrect\. 4 attempts left/, 400);
  assert.ok(err);
  assert.equal(db.__doc('emailVerifications', UID).attempts, 1);
  assert.equal(marked.length, 0, 'failed attempt must not touch auth');
});

await test(`the ${MAX_ATTEMPTS + 1}th wrong attempt invalidates the code (doc deleted)`, async () => {
  const { db, now } = await seededWithCode('246810');
  const { deps, marked } = makeDeps(db, { now: now + 60_000 });
  // Attempts 1..5 each increment and answer "X attempts left".
  for (const expected of [4, 3, 2, 1, 0]) {
    await expectError(
      () => confirmVerifyCode(deps, user(), { code: '000000' }),
      new RegExp(`incorrect\\. ${expected} attempt`),
      400,
    );
  }
  assert.equal(db.__doc('emailVerifications', UID).attempts, MAX_ATTEMPTS);
  // The 6th guess — even with the CORRECT code — is rejected and burns the doc.
  await expectError(() => confirmVerifyCode(deps, user(), { code: '246810' }), /Too many wrong attempts\. Request a new code\./, 400);
  assert.equal(db.__doc('emailVerifications', UID), undefined, 'verification doc must be deleted');
  assert.equal(marked.length, 0);
  assert.equal(db.__doc('users', UID).emailVerified, undefined);
});

await test('expired code rejected with the expiry message and doc deleted', async () => {
  const { db, now } = await seededWithCode('246810', { expired: true });
  const { deps } = makeDeps(db, { now: now + CODE_TTL_MS + 1 });
  await expectError(() => confirmVerifyCode(deps, user(), { code: '246810' }), /This code has expired\. Request a new one\./, 400);
  assert.equal(db.__doc('emailVerifications', UID), undefined);
});

await test('missing / malformed code rejected before touching the DB', async () => {
  const { db, now } = await seededWithCode('246810');
  const { deps } = makeDeps(db, { now });
  await expectError(() => confirmVerifyCode(deps, user(), {}), /6-digit code/, 400);
  await expectError(() => confirmVerifyCode(deps, user(), { code: '12345' }), /6-digit code/, 400);
  await expectError(() => confirmVerifyCode(deps, user(), { code: 'abcdef' }), /6-digit code/, 400);
  await expectError(() => confirmVerifyCode(deps, user(), { code: '1234567' }), /6-digit code/, 400);
  assert.equal(db.__doc('emailVerifications', UID).attempts, 0, 'malformed input must not consume attempts');
});

await test('no verification doc answers the expiry message', async () => {
  const db = createFakeDb();
  db.__seed('users', UID, { uid: UID, email: EMAIL });
  const { deps } = makeDeps(db);
  await expectError(() => confirmVerifyCode(deps, user(), { code: '123456' }), /This code has expired\. Request a new one\./, 400);
});

// ---------------------------------------------------------------------------
console.log('\nemail-verify: leak & template checks');
// ---------------------------------------------------------------------------
await test('the code is never stored in plain text and never logged (full flow)', async () => {
  const spy = spyConsole();
  try {
    const db = createFakeDb();
    db.__seed('users', UID, { uid: UID, email: EMAIL });
    const now = Date.now();
    const CODE = '908123';
    const { deps, waitUntilJobs } = makeDeps(db, { now, generateCode: () => CODE });

    const sendResult = await sendVerifyCode(deps, user(), {});
    assert.equal(sendResult.sent, true);
    // Wrong guesses, then the right one.
    await expectError(() => confirmVerifyCode(makeDeps(db, { now: now + 1 }).deps, user(), { code: '000000' }), /incorrect/);
    const confirmResult = await confirmVerifyCode(makeDeps(db, { now: now + 2 }).deps, user(), { code: CODE });
    assert.deepEqual(confirmResult, { verified: true });
    await Promise.all(waitUntilJobs);

    // Every response body and every piece of persisted state (while the code
    // still existed) must be free of the plain digits.
    assert.ok(!JSON.stringify(sendResult).includes(CODE));
    assert.ok(!JSON.stringify(confirmResult).includes(CODE));
    const storedWhileAlive = JSON.stringify({
      verification: { codeHash: hashCode(TEST_KEY, UID, CODE), expiresAt: now + CODE_TTL_MS, attempts: 1 },
      users: db.__list('users'),
    });
    assert.ok(!storedWhileAlive.includes(CODE), 'only the hash lives in Firestore');

    // Nothing in the console output may contain the code either.
    for (const line of spy.lines) {
      assert.ok(!line.includes(CODE), `log line leaks the code: ${line.slice(0, 120)}`);
    }
  } finally {
    spy.restore();
  }
});

await test('verification email contains the code, expiry copy and NO links', () => {
  const { subject, htmlContent } = verificationCodeEmail('123456');
  assert.equal(subject, 'Your HerStep verification code: 123456');
  assert.ok(htmlContent.includes('1&#8202;2&#8202;3&#8202;4&#8202;5&#8202;6'), 'large spaced digits');
  assert.ok(htmlContent.includes('It expires in 10 minutes. If you did not request this, ignore this email.'));
  assert.ok(!/<a\s/i.test(htmlContent), 'no anchor tags anywhere');
  assert.ok(!/href=/i.test(htmlContent), 'no href attributes');
  assert.ok(!/https?:\/\//i.test(htmlContent), 'no URLs at all');
  assert.ok(htmlContent.includes('HERSTEP COLLECTION'), 'branded template reused');
  // HTML metacharacters in the code slot are stripped/escaped defensively.
  const evil = verificationCodeEmail('<script>alert(1)</script>12');
  assert.ok(!evil.htmlContent.includes('<script>'));
  assert.ok(!evil.subject.includes('<script>'));
});

// ---------------------------------------------------------------------------
// Summary
// ---------------------------------------------------------------------------
console.log(`\nemail-verify: ${passed} passed, ${failures.length} failed`);
if (failures.length > 0) {
  for (const [name, err] of failures) console.error(`FAILED: ${name}\n${err.stack || err.message}`);
  process.exit(1);
}
