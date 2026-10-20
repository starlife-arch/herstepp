// Module hooks: stub firebase-admin entry points AND mpesa-provider so the
// seller-promotions route runs fully offline against injected fakes.
export function resolve(specifier, context, nextResolve) {
  if (specifier === 'firebase-admin/app' || specifier === 'firebase-admin/auth' || specifier === 'firebase-admin/firestore') {
    return { shortCircuit: true, url: `stub:${specifier}`, format: 'module' };
  }
  if (specifier.endsWith('mpesa-provider.js')) {
    return { shortCircuit: true, url: 'stub:mpesa-provider', format: 'module' };
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
  'stub:mpesa-provider': `
    export const getMpesaProvider = () => globalThis.__promotionState.provider;`,
};
export function load(url, context, nextLoad) {
  if (url.startsWith('stub:')) return { shortCircuit: true, format: 'module', source: STUB_EXPORTS[url] };
  return nextLoad(url, context);
}
