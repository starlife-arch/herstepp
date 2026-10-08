// Test bootstrap for scripts/test-seo.mjs (run via --import).
// Stubs firebase-admin with the shared in-memory fake Firestore and keeps a
// controllable global fetch: tests set __seoState.fetchImpl to simulate the
// static index.html, an outage, or a Firestore failure.
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { createFakeDb } from '../api/_lib/fake-firestore.js';

const INDEX_HTML = '<!doctype html>\n<html lang="en">\n  <head>\n    <meta charset="UTF-8" />\n    <title>HerStep Collection | Step Into Your Style</title>\n    <meta name="description" content="default" />\n  </head>\n  <body><div id="root"></div></body>\n</html>\n';

const state = {
  db: createFakeDb(),
  fetchImpl: async (url) => ({
    ok: true,
    status: 200,
    text: async () => INDEX_HTML,
    json: async () => ({}),
  }),
};

process.env.FIREBASE_ADMIN_PROJECT_ID ||= 'herstep-test';
process.env.FIREBASE_ADMIN_CLIENT_EMAIL ||= 'test@herstep-test.iam.gserviceaccount.com';
process.env.FIREBASE_ADMIN_PRIVATE_KEY ||= '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----';
process.env.SITE_URL ||= 'https://herstepcollection.shop';

globalThis.__seoState = {
  get db() { return state.db; },
  set fetchImpl(fn) { state.fetchImpl = fn; },
  get fetchImpl() { return state.fetchImpl; },
  INDEX_HTML,
  reset() { state.db = createFakeDb(); },
};

// firebase-admin.js (real file, stubbed SDK entry points) resolves the DB via
// __stubDb — same contract as the contact suite. Without these the whole seo
// suite dies with "globalThis.__stubDb is not a function".
globalThis.__stubDb = () => globalThis.__seoState.db;
globalThis.__stubApp = {};
globalThis.__stubPending = [];

globalThis.fetch = async (url, init) => globalThis.__seoState.fetchImpl(url, init);

register('./seo-hooks.mjs', import.meta.url);
