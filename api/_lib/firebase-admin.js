import { cert, getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore } from 'firebase-admin/firestore';
import { clientError } from './http.js';

// Shared cache for the users/{uid} role lookup used by requireAdmin. Admin
// sessions are few and roles change rarely, so a tiny TTL cache removes one
// Firestore READ per admin API call (admin pages fan out to many calls).
const roleCache = new Map(); // uid -> { role, expiresAt }
const ROLE_CACHE_TTL_MS = 30_000;

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

// verifyUserToken is requireUser's token check with an explicit revocation
// policy: customer routes use checkRevoked=false (one less network call per
// request); admin-only routes MUST pass checkRevoked=true.
export async function verifyUserToken(token, checkRevoked) {
  try {
    const decoded = await adminAuth.verifyIdToken(token, checkRevoked);
    return { ...decoded, signInProvider: decoded.firebase?.sign_in_provider ?? '' };
  } catch {
    throw clientError('Authentication is required.', 401);
  }
}

function bearerToken(req) {
  const authorization = req.headers.authorization;
  const token = authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  if (!token) {
    throw clientError('Authentication is required.', 401);
  }
  return token;
}

export async function requireUser(req) {
  // FASTER AUTH: checkRevoked=false — see the note in verifyUserToken.
  return verifyUserToken(bearerToken(req), false);
}

export async function requireAdmin(req) {
  // Admin-only paths keep revocation checks (still one extra network call,
  // but only for the handful of admin requests where it matters).
  const user = await verifyUserToken(bearerToken(req), true);
  // Role lookup is cached briefly so a dashboard fan-out of N admin calls
  // costs ONE users/{uid} read instead of N.
  const cached = roleCache.get(user.uid);
  if (cached && cached.expiresAt > Date.now()) {
    if (cached.role !== 'ADMIN' && cached.role !== 'SUPER_ADMIN') {
      throw clientError('Administrator access is required.', 403);
    }
    return user;
  }
  const userSnapshot = await adminDb.collection('users').doc(user.uid).get();
  const role = userSnapshot.data()?.role;
  roleCache.set(user.uid, { role, expiresAt: Date.now() + ROLE_CACHE_TTL_MS });
  if (role !== 'ADMIN' && role !== 'SUPER_ADMIN') {
    throw clientError('Administrator access is required.', 403);
  }
  return user;
}
