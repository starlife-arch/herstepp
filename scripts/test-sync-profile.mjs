// Offline test suite for api/_lib/routes/sync-profile-core.js — NO network,
// NO Firebase credentials. Exercises every branch against the in-memory fake
// Firestore: google.com accounts may create a profile WITHOUT a phone;
// password accounts still need a valid Kenyan phone for a NEW profile; role
// is always server-fixed CUSTOMER (never taken from the client); welcome
// email + Telegram ping fire exactly like email sign-ups.
//
// Run with: npm test
import assert from 'node:assert/strict';
import { createFakeDb } from '../api/_lib/fake-firestore.js';
import { syncProfileCore } from '../api/_lib/routes/sync-profile-core.js';

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

function makeDeps() {
  const db = createFakeDb();
  const telegram = [];
  const deliveredEmailKeys = [];
  const waitUntilPromises = [];
  const deps = {
    db,
    waitUntil: promise => { waitUntilPromises.push(promise); },
    sendTelegramMessage: async text => { telegram.push(text); return true; },
    deliverQueuedEmailInline: async (_db, key) => { deliveredEmailKeys.push(key); return true; },
  };
  return { db, deps, telegram, deliveredEmailKeys, waitUntilPromises };
}

const GOOGLE_USER = {
  uid: 'g-user-1',
  email: 'google.user@gmail.com',
  displayName: 'Google User',
  signInProvider: 'google.com',
  firebase: { sign_in_provider: 'google.com' },
};

const PASSWORD_USER = {
  uid: 'p-user-1',
  email: 'password.user@example.com',
  displayName: '',
  signInProvider: 'password',
  firebase: { sign_in_provider: 'password' },
};

console.log('\nsync-profile-core');

await test('google account WITHOUT phone creates profile with phoneNumber ""', async () => {
  const { db, deps, telegram, deliveredEmailKeys, waitUntilPromises } = makeDeps();
  const result = await syncProfileCore(deps, GOOGLE_USER, {});
  assert.equal(result.ok, true);
  const snap = await db.collection('users').doc(GOOGLE_USER.uid).get();
  assert.equal(snap.exists, true);
  const data = snap.data();
  assert.equal(data.phoneNumber, '');
  assert.equal(data.displayName, 'Google User'); // from the Google profile
  assert.equal(data.role, 'CUSTOMER');
  assert.equal(data.email, 'google.user@gmail.com');
  // Same side effects as an email sign-up: welcome email + Telegram ping.
  await Promise.all(waitUntilPromises);
  assert.equal(deliveredEmailKeys.length, 1);
  assert.equal(deliveredEmailKeys[0], `${GOOGLE_USER.uid}-WELCOME`);
  const outboxSnap = await db.collection('emailOutbox').doc(`${GOOGLE_USER.uid}-WELCOME`).get();
  assert.equal(outboxSnap.exists, true, 'welcome email must be queued in the outbox');
  assert.equal(telegram.length, 1);
  assert.match(telegram[0], /New customer sign-up: Google User/);
});

await test('google displayName from body wins over token displayName', async () => {
  const { db, deps } = makeDeps();
  await syncProfileCore(deps, GOOGLE_USER, { displayName: 'Jane Google' });
  const data = (await db.collection('users').doc(GOOGLE_USER.uid).get()).data();
  assert.equal(data.displayName, 'Jane Google');
});

await test('password account WITHOUT phone is REJECTED for a new profile', async () => {
  const { deps } = makeDeps();
  await assert.rejects(
    () => syncProfileCore(deps, PASSWORD_USER, {}),
    /A valid phone number is required\./,
  );
});

await test('password account with INVALID phone is still rejected', async () => {
  const { deps } = makeDeps();
  await assert.rejects(
    () => syncProfileCore(deps, PASSWORD_USER, { phoneNumber: '0712345' }),
    /phone/i,
  );
});

await test('password account WITH valid Kenyan phone creates profile (unchanged path)', async () => {
  const { db, deps, telegram, deliveredEmailKeys, waitUntilPromises } = makeDeps();
  await syncProfileCore(deps, PASSWORD_USER, { displayName: 'Jane Doe', phoneNumber: '0712 345 678' });
  const data = (await db.collection('users').doc(PASSWORD_USER.uid).get()).data();
  assert.equal(data.phoneNumber, '+254712345678');
  assert.equal(data.role, 'CUSTOMER');
  await Promise.all(waitUntilPromises);
  assert.equal(deliveredEmailKeys.length, 1);
  assert.equal(telegram.length, 1);
});

await test('role is NEVER taken from the client', async () => {
  const { db, deps } = makeDeps();
  await syncProfileCore(deps, GOOGLE_USER, { role: 'SUPER_ADMIN' });
  const data = (await db.collection('users').doc(GOOGLE_USER.uid).get()).data();
  assert.equal(data.role, 'CUSTOMER');
});

await test('existing profile update works and normalizes a provided phone', async () => {
  const { db, deps, telegram } = makeDeps();
  db.__seed('users', GOOGLE_USER.uid, {
    uid: GOOGLE_USER.uid, email: GOOGLE_USER.email, displayName: 'Old Name',
    phoneNumber: '', role: 'CUSTOMER', marketingConsent: false,
  });
  await syncProfileCore(deps, GOOGLE_USER, { phoneNumber: '+254712345678', displayName: 'New Name' });
  const data = (await db.collection('users').doc(GOOGLE_USER.uid).get()).data();
  assert.equal(data.phoneNumber, '+254712345678');
  assert.equal(data.displayName, 'New Name');
  assert.equal(telegram.length, 0, 'no second welcome on an existing profile');
});

await test('invalid phone on an EXISTING profile does not wipe it', async () => {
  const { db, deps } = makeDeps();
  db.__seed('users', GOOGLE_USER.uid, {
    uid: GOOGLE_USER.uid, email: GOOGLE_USER.email, displayName: 'Kept',
    phoneNumber: '+254712345678', role: 'CUSTOMER',
  });
  await assert.rejects(() => syncProfileCore(deps, GOOGLE_USER, { phoneNumber: '12345' }));
  const data = (await db.collection('users').doc(GOOGLE_USER.uid).get()).data();
  assert.equal(data.phoneNumber, '+254712345678');
});

if (failures.length > 0) {
  console.error(`\n${failures.length} sync-profile test(s) FAILED`);
  process.exit(1);
}
console.log(`\nAll ${passed} sync-profile tests passed.`);
