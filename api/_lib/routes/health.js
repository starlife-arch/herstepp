import { methodNotAllowed } from '../http.js';

const requiredEnvironmentVariables = [
  'FIREBASE_API_KEY',
  'FIREBASE_AUTH_DOMAIN',
  'FIREBASE_PROJECT_ID',
  'FIREBASE_STORAGE_BUCKET',
  'FIREBASE_MESSAGING_SENDER_ID',
  'FIREBASE_APP_ID',
  'FIREBASE_ADMIN_PROJECT_ID',
  'FIREBASE_ADMIN_CLIENT_EMAIL',
  'FIREBASE_ADMIN_PRIVATE_KEY',
  'CLOUDINARY_CLOUD_NAME',
  'CLOUDINARY_API_KEY',
  'CLOUDINARY_API_SECRET',
  'PRINTPAY_API_KEY',
  'PRINTPAY_API_BASE_URL',
];

export default async function health(req, res) {
  if (req.method !== 'GET') {
    return methodNotAllowed(res, 'GET');
  }

  const missing = requiredEnvironmentVariables.filter((name) => !process.env[name]?.trim());
  const queryDeep = Array.isArray(req.query.deep) ? req.query.deep[0] : req.query.deep;
  const deep = queryDeep === '1' || queryDeep === 'true';

  if (!deep) {
    return res.status(200).json({ missing });
  }

  // Deep check: run one tiny Firestore read and report ONLY a safe error code.
  // Never leak message text, stack traces or project details.
  let firestore = { ok: true };
  try {
    const { adminDb } = await import('../firebase-admin.js');
    await adminDb.collection('settings').doc('checkout').get();
  } catch (error) {
    const code = typeof error?.code === 'number' ? error.code : String(error?.code ?? error?.name ?? 'UNKNOWN');
    firestore = { ok: false, code };
  }

  const body = {
    ok: missing.length === 0 && firestore.ok,
    missing,
    firestore,
  };
  if (!firestore.ok) {
    body.hint = 'Firestore is unreachable or its quota is exhausted. Check the Firebase console usage page.';
  }
  return res.status(firestore.ok ? 200 : 503).json(body);
}
