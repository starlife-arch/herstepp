// POST /api/auth/verify/send and POST /api/auth/verify/confirm — thin HTTP
// wrappers around email-verify-core.js (registered in api/users.js as
// ?route=auth/verify/send and ?route=auth/verify/confirm). All logic lives in
// the core so it is unit-testable offline against the fake Firestore.
import { waitUntil } from '@vercel/functions';
import { adminAuth, adminDb, requireUser } from '../firebase-admin.js';
import { methodNotAllowed } from '../http.js';
import { emailConfig, deliverQueuedEmailInline, verifySenderConfigured } from '../email-service.js';
import { sendVerifyCode, confirmVerifyCode, verifyKey } from './email-verify-core.js';

function deps() {
  return {
    db: adminDb,
    now: Date.now(),
    waitUntil,
    deliverQueuedEmailInline,
    // Env is read per request so a redeploy with new variables takes effect
    // without restarting anything.
    verifySenderConfigured: () => verifySenderConfigured(emailConfig()),
    verifyKey: () => verifyKey(process.env),
    markAuthEmailVerified: uid => adminAuth.updateUser(uid, { emailVerified: true }),
  };
}

export async function verifySend(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
  const user = await requireUser(req);
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const result = await sendVerifyCode(deps(), user, body);
  return res.status(200).json(result);
}

export async function verifyConfirm(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
  const user = await requireUser(req);
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  const result = await confirmVerifyCode(deps(), user, body);
  return res.status(200).json(result);
}
