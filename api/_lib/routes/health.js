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

// gRPC status numbers used by Firestore.
const GRPC_NAMES = {
  1: 'CANCELLED',
  2: 'UNKNOWN',
  3: 'INVALID_ARGUMENT',
  4: 'DEADLINE_EXCEEDED',
  5: 'NOT_FOUND',
  7: 'PERMISSION_DENIED',
  8: 'RESOURCE_EXHAUSTED',
  9: 'FAILED_PRECONDITION',
  14: 'UNAVAILABLE',
  16: 'UNAUTHENTICATED',
};

// Fixed, human-readable hints. The raw error message is NEVER returned, so no
// secret or internal detail can leak through this public endpoint.
const HINTS = {
  RESOURCE_EXHAUSTED:
    'Firestore quota is used up (free plan: 50,000 reads per day, resets at 10:00 Nairobi time). Reduce reads or upgrade to the Blaze plan.',
  UNAUTHENTICATED:
    'Firebase rejected the service account key. It may be deleted or rotated: update FIREBASE_ADMIN_PRIVATE_KEY and FIREBASE_ADMIN_CLIENT_EMAIL in Vercel and redeploy.',
  PERMISSION_DENIED:
    'The service account has no permission to use Firestore. Check its roles in Google Cloud IAM.',
  NOT_FOUND: 'The Firestore database was not found for this project id.',
  UNAVAILABLE: 'Firestore could not be reached right now. Try again shortly.',
  CONFIG: 'A server environment variable is missing or invalid.',
};

function describeError(error) {
  const raw = error?.code;
  let code = typeof raw === 'number' ? GRPC_NAMES[raw] || String(raw) : String(raw || 'UNKNOWN');
  const message = String(error?.message || '');

  // firebase-admin.js throws a 503 for missing/invalid env vars at import time.
  if (error?.statusCode === 503) code = 'CONFIG';
  // Expired or deleted keys often surface as an auth error without a clean code.
  if (/invalid_grant|invalid jwt|private key|could not load the default credentials/i.test(message)) {
    code = 'UNAUTHENTICATED';
  }
  if (/quota|resource_exhausted/i.test(message)) code = 'RESOURCE_EXHAUSTED';

  return { firestore: 'error', code, hint: HINTS[code] || 'Check the Vercel function logs for this deployment.' };
}

// A deep check costs one Firestore read, so cache the result for 20 seconds to
// stop anyone hammering the endpoint.
let cached = null;

async function checkFirestore() {
  if (cached && Date.now() - cached.at < 20_000) return cached.result;

  let result;
  try {
    const { adminDb } = await import('../firebase-admin.js');
    await adminDb.collection('settings').doc('checkout').get();
    result = { firestore: 'ok' };
  } catch (error) {
    result = describeError(error);
  }

  cached = { at: Date.now(), result };
  return result;
}

export default async function health(req, res) {
  if (req.method !== 'GET') {
    return methodNotAllowed(res, 'GET');
  }

  const missing = requiredEnvironmentVariables.filter((name) => !process.env[name]?.trim());
  const deep = req.query?.deep === '1' || req.query?.deep === 'true';

  if (!deep) {
    return res.status(200).json({ missing });
  }

  const firestore = await checkFirestore();
  return res.status(200).json({ missing, ...firestore });
}
