// Module customization hooks for scripts/test-contact.mjs: replace ONLY the
// 'firebase-admin/*' entry points and '@vercel/functions' with in-memory
// fakes. Every other specifier resolves to the REAL files, so the suite runs
// the genuine production wiring (api/users.js -> contact.js -> contact-core).
export function resolve(specifier, context, nextResolve) {
  if (specifier === 'firebase-admin/app' || specifier === 'firebase-admin/auth'
    || specifier === 'firebase-admin/firestore' || specifier === '@vercel/functions') {
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
      verifyIdToken: async (token, checkRevoked) => {
        if (token === 'bad') throw new Error('invalid token');
        return { uid: String(token), email: String(token) + '@example.com', name: 'Tok' };
      },
    });`,
  'stub:firebase-admin/firestore': `
    export const getFirestore = () => globalThis.__stubDb();
    export const FieldValue = { serverTimestamp: () => globalThis.__stubDb().__serverTimestamp() };`,
  'stub:@vercel/functions': `
    export const waitUntil = (p) => { globalThis.__stubPending.push(p); };`,
};

export function load(url, context, nextLoad) {
  if (url.startsWith('stub:')) {
    return { shortCircuit: true, format: 'module', source: STUB_EXPORTS[url] };
  }
  return nextLoad(url, context);
}
