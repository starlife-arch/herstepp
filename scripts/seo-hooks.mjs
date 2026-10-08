// Module customization hooks for scripts/test-seo.mjs: stub ONLY the
// 'firebase-admin/*' entry points so api/_lib/firebase-admin.js initialises
// offline and hands out the shared in-memory fake Firestore. Everything else
// (api/catalog.js, route-dispatch, seo.js) resolves to the REAL production
// files, so the suite exercises the genuine dispatch wiring.
export function resolve(specifier, context, nextResolve) {
  if (specifier === 'firebase-admin/app' || specifier === 'firebase-admin/auth' || specifier === 'firebase-admin/firestore') {
    return { shortCircuit: true, url: `stub:${specifier}`, format: 'module' };
  }
  return nextResolve(specifier, context);
}

const STUB_EXPORTS = {
  'stub:firebase-admin/app': `
    export const cert = () => ({ fake: true });
    export const getApps = () => [globalThis.__stubApp];
    export const initializeApp = () => globalThis.__stubApp;`,
  'stub:firebase-admin/auth': `
    export const getAuth = () => ({
      verifyIdToken: async (token) => {
        if (token === 'bad') throw new Error('invalid token');
        return { uid: String(token), email: String(token) + '@example.com', name: 'Tok' };
      },
    });`,
  'stub:firebase-admin/firestore': `
    export const getFirestore = () => globalThis.__stubDb();
    export const FieldValue = { serverTimestamp: () => globalThis.__stubDb().__serverTimestamp() };`,
};

export function load(url, context, nextLoad) {
  if (url.startsWith('stub:')) {
    return { shortCircuit: true, format: 'module', source: STUB_EXPORTS[url] };
  }
  return nextLoad(url, context);
}
