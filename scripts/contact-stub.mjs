// Test bootstrap for scripts/test-contact.mjs (run via --import).
// firebase-admin refuses to initialize without real service-account env vars,
// so the HTTP wrappers cannot be imported offline as-is. This module registers
// contact-hooks.mjs (which stubs only firebase-admin/* and @vercel/functions)
// and prepares the shared in-memory Firestore the stubs hand out.
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createFakeDb } from '../api/_lib/fake-firestore.js';

function seedUsers(db) {
  db.__seed('users', 'admin-1', { uid: 'admin-1', email: 'a@example.com', displayName: 'Ada', role: 'ADMIN' });
  db.__seed('users', 'customer-1', { uid: 'customer-1', email: 'c@example.com', displayName: 'Cust', role: 'CUSTOMER' });
  return db;
}

const state = { db: seedUsers(createFakeDb()) };
const pendingWork = [];

globalThis.__contactStubs = {
  get db() { return state.db; },
  pendingWork,
  reset() { state.db = seedUsers(createFakeDb()); },
};
globalThis.__stubApp = { name: 'fake-app' };
globalThis.__stubDb = () => state.db;
globalThis.__stubPending = pendingWork;

register('./contact-hooks.mjs', import.meta.url);
void pathToFileURL;
