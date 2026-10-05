// Email verification by 6-digit code — replaceable core of
//   POST /api/auth/verify/send    and
//   POST /api/auth/verify/confirm
// kept free of Vercel-only imports so scripts/test-email-verify.mjs can run
// every branch against the strict in-memory fake Firestore (api/_lib/fake-firestore.js).
//
// SECURITY CONTRACT
// - Only an HMAC-SHA256 digest of `${uid}:${code}` is ever stored
//   (emailVerifications/{uid}.codeHash). The plain code never touches
//   Firestore, the outbox payload or the logs.
// - The HMAC key comes from VERIFY_CODE_SECRET when that variable happens to
//   be set; otherwise it is DERIVED from FIREBASE_ADMIN_PRIVATE_KEY with
//   HKDF-SHA256 (salt 'herstep-verify-salt', info 'email-verify-code-v1',
//   32 bytes) — so NO new secret has to be provisioned for this feature.
// - Codes are compared with crypto.timingSafeEqual.
// - Google sign-ups already have a verified email: they get {verified:true}
//   without any code being generated or emailed.
import crypto from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { clientError } from '../http.js';
import { queueEmail } from '../email-service.js';
import { verificationCodeEmail } from '../email-templates.js';
import { isGoogleProvider } from './sync-profile-core.js';

export const CODE_TTL_MS = 10 * 60_000;      // codes live 10 minutes
export const RESEND_COOLDOWN_MS = 60_000;    // one send per 60 s …
export const HOURLY_WINDOW_MS = 60 * 60_000; // … and five per hour
export const MAX_HOURLY_SENDS = 5;
export const MAX_ATTEMPTS = 5;               // the 6th wrong code invalidates
export const NOT_CONFIGURED_MESSAGE = 'Verification emails are not configured yet.';

// ---- Key derivation ---------------------------------------------------------
// hkdfSync returns an ArrayBuffer — wrap it in a Buffer before using it.
export function deriveVerifyKey(privateKey) {
  const material = String(privateKey || '').trim();
  if (!material) {
    throw clientError(NOT_CONFIGURED_MESSAGE, 503);
  }
  return Buffer.from(crypto.hkdfSync(
    'sha256',
    material,
    'herstep-verify-salt',
    'email-verify-code-v1',
    32,
  ));
}

// Prefer an explicit VERIFY_CODE_SECRET when present, otherwise derive the
// key from the Firebase admin private key (already required by every route).
export function verifyKey(env = globalThis.process?.env || {}) {
  const explicit = String(env.VERIFY_CODE_SECRET || '').trim();
  if (explicit) return Buffer.from(explicit, 'utf8');
  const privateKey = String(env.FIREBASE_ADMIN_PRIVATE_KEY || '').replace(/\\n/g, '\n');
  return deriveVerifyKey(privateKey);
}

export function hashCode(key, uid, code) {
  return crypto.createHmac('sha256', key).update(`${uid}:${code}`).digest('hex');
}

function safeEquals(a, b) {
  const bufA = Buffer.from(String(a), 'utf8');
  const bufB = Buffer.from(String(b), 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// ---- Small helpers ----------------------------------------------------------
export function maskEmail(email) {
  const value = String(email || '');
  const at = value.indexOf('@');
  if (at <= 0) return value ? `${value.slice(0, 1)}***` : '***';
  const domain = value.slice(at + 1);
  return `${value.slice(0, 1)}***@${domain}`;
}

function millis(value) {
  if (value == null) return 0;
  if (typeof value === 'number') return value;
  if (typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value.valueOf === 'function') {
    const raw = value.valueOf();
    if (typeof raw === 'number' && Number.isFinite(raw)) return raw;
  }
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

const secondsUntil = (ms, now) => Math.max(0, Math.ceil((ms - now) / 1000));

// ---- POST /api/auth/verify/send ---------------------------------------------
export async function sendVerifyCode(deps, user, body = {}) {
  const { db, now = Date.now() } = deps;
  const uid = user.uid;

  // Already verified (token claim, or the profile flag written on confirm).
  if (user.email_verified === true) return { verified: true };

  // Google accounts are verified by Google itself — never send them a code.
  if (isGoogleProvider(user)) return { verified: true };

  const profileSnap = await db.collection('users').doc(uid).get();
  if (profileSnap.data()?.emailVerified === true) return { verified: true };

  const email = String(body.email || user.email || profileSnap.data()?.email || '').trim().toLowerCase();
  if (!email) throw clientError('We could not find an email address on your account.', 400);

  // No fallback sender for the 'verify' purpose: refuse loudly instead of
  // silently dropping the only copy of the customer's code.
  if (!deps.verifySenderConfigured()) {
    throw clientError(NOT_CONFIGURED_MESSAGE, 503);
  }

  const ref = db.collection('emailVerifications').doc(uid);
  const current = await ref.get();
  const data = current.data() || null;

  // Rate limits are checked BEFORE generating anything, so a rejected request
  // never burns a code or queues an email.
  const lastSentAt = millis(data?.lastSentAt);
  if (data && lastSentAt && now - lastSentAt < RESEND_COOLDOWN_MS) {
    throw clientError(
      `Please wait before requesting another code. You can request a new one in ${secondsUntil(lastSentAt + RESEND_COOLDOWN_MS, now)} seconds.`,
      429,
    );
  }
  const windowStart = millis(data?.hourWindowStart);
  const freshWindow = !windowStart || now - windowStart >= HOURLY_WINDOW_MS;
  const hourCount = freshWindow ? 0 : Number(data?.hourCount) || 0;
  if (hourCount >= MAX_HOURLY_SENDS) {
    throw clientError(
      'You have requested too many codes recently. Please try again in a few minutes.',
      429,
    );
  }

  const key = deps.verifyKey();
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const createdAt = millis(data?.createdAt) || now;
  const template = verificationCodeEmail(code);

  await db.runTransaction(async tx => {
    tx.set(ref, {
      codeHash: hashCode(key, uid, code),
      expiresAt: now + CODE_TTL_MS,
      attempts: 0,
      lastSentAt: now,
      hourWindowStart: freshWindow ? now : windowStart,
      hourCount: hourCount + 1,
      createdAt,
    });
    // Deterministic key keeps a replayed request from double-sending.
    queueEmail(tx, db, {
      key: `${uid}-VERIFY-${now}`,
      purpose: 'verify',
      to: email,
      subject: template.subject,
      htmlContent: template.htmlContent,
    });
  });

  // Delivered AFTER the write, best-effort — email must never block signup.
  deps.waitUntil(Promise.resolve(deps.deliverQueuedEmailInline(db, `${uid}-VERIFY-${now}`)).catch(() => {}));

  return {
    sent: true,
    maskedEmail: maskEmail(email),
    expiresInSeconds: CODE_TTL_MS / 1000,
    resendInSeconds: RESEND_COOLDOWN_MS / 1000,
  };
}

// ---- POST /api/auth/verify/confirm -------------------------------------------
export async function confirmVerifyCode(deps, user, body = {}) {
  const { db, now = Date.now() } = deps;
  const uid = user.uid;

  if (user.email_verified === true) return { verified: true };

  const rawCode = typeof body.code === 'string' ? body.code.trim() : '';
  if (!/^\d{6}$/.test(rawCode)) {
    throw clientError('Enter the 6-digit code from your email.');
  }

  const ref = db.collection('emailVerifications').doc(uid);
  const snapshot = await ref.get();
  const data = snapshot.data();
  if (!data || !data.codeHash) {
    throw clientError('This code has expired. Request a new one.');
  }
  if (millis(data.expiresAt) <= now) {
    await ref.delete().catch(() => {});
    throw clientError('This code has expired. Request a new one.');
  }
  const attempts = Number(data.attempts) || 0;
  if (attempts >= MAX_ATTEMPTS) {
    await ref.delete().catch(() => {});
    throw clientError('Too many wrong attempts. Request a new code.');
  }

  if (!safeEquals(String(data.codeHash), hashCode(deps.verifyKey(), uid, rawCode))) {
    // Wrong code: bump attempts inside a transaction so concurrent guesses
    // cannot both slip past the limit.
    let remaining = 0;
    await db.runTransaction(async tx => {
      const fresh = await tx.get(ref);
      const used = Number(fresh.data()?.attempts) || 0;
      remaining = Math.max(0, MAX_ATTEMPTS - used - 1);
      tx.update(ref, { attempts: used + 1 });
    });
    throw clientError(`That code is incorrect. ${remaining} attempt${remaining === 1 ? '' : 's'} left.`);
  }

  // Success: mark the Auth user verified so future ID tokens carry
  // email_verified=true, mirror it on users/{uid}, drop the code.
  await deps.markAuthEmailVerified(uid);
  const userRef = db.collection('users').doc(uid);
  await userRef.set({ emailVerified: true, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
  await ref.delete();

  return { verified: true };
}
