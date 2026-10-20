// Test bootstrap for scripts/test-seller-promotions.mjs (run via --import).
// Stubs firebase-admin with the shared in-memory fake Firestore and replaces
// getMpesaProvider() with a controllable fake so no network is ever touched.
import { register } from 'node:module';
import { createFakeDb } from '../api/_lib/fake-firestore.js';

process.env.FIREBASE_ADMIN_PROJECT_ID ||= 'herstep-test';
process.env.FIREBASE_ADMIN_CLIENT_EMAIL ||= 'test@herstep-test.iam.gserviceaccount.com';
process.env.FIREBASE_ADMIN_PRIVATE_KEY ||= '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----';

const state = { db: createFakeDb(), provider: null };
globalThis.__promotionState = {
  get db() { return state.db; },
  set provider(fn) { state.provider = fn; },
  get provider() { return state.provider; },
  reset() { state.db = createFakeDb(); },
};
globalThis.__stubDb = () => globalThis.__promotionState.db;
globalThis.__stubApp = {};
globalThis.__stubPending = [];

register('./promotion-hooks.mjs', import.meta.url);
