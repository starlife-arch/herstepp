import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { clientError } from './http.js';

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw clientError(`Server configuration is missing ${name}.`, 503);
  }
  return value;
}

const projectId = requiredEnvironment('FIREBASE_ADMIN_PROJECT_ID');
const clientEmail = requiredEnvironment('FIREBASE_ADMIN_CLIENT_EMAIL');
const privateKey = requiredEnvironment('FIREBASE_ADMIN_PRIVATE_KEY').replace(/\\n/g, '\n');

if (!privateKey.includes('-----BEGIN PRIVATE KEY-----') || !privateKey.includes('-----END PRIVATE KEY-----')) {
  throw clientError('Server configuration has an invalid FIREBASE_ADMIN_PRIVATE_KEY.', 503);
}

const adminApp = getApps()[0] || initializeApp({
  credential: cert({ projectId, clientEmail, privateKey }),
});

export const adminAuth = getAuth(adminApp);
export const adminDb = getFirestore(adminApp);

export async function requireUser(req) {
  const authorization = req.headers.authorization;
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) {
    throw clientError('Authentication is required.', 401);
  }

  try {
    // email_verified / firebase.identities.email come from the verified token
    // itself — order creation reads them instead of trusting any client field.
    const decoded = await adminAuth.verifyIdToken(token, true);
    // Expose the provider that signed this session in ('password',
    // 'google.com', ...) as a flat claim so routes (e.g. sync-profile) can
    // branch on it without digging into decoded.firebase each time.
    return { ...decoded, signInProvider: decoded.firebase?.sign_in_provider ?? '' };
  } catch {
    throw clientError('Authentication is required.', 401);
  }
}

export async function requireAdmin(req) {
  const user = await requireUser(req);
  const userSnapshot = await adminDb.collection('users').doc(user.uid).get();
  const role = userSnapshot.data()?.role;

  if (role !== 'ADMIN' && role !== 'SUPER_ADMIN') {
    throw clientError('Administrator access is required.', 403);
  }

  return user;
}
