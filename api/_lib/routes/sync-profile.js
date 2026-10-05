import { waitUntil } from '@vercel/functions';
import { adminDb, requireUser } from '../firebase-admin.js';
import { methodNotAllowed } from '../http.js';
import { sendTelegramMessage } from '../telegram.js';
import { deliverQueuedEmailInline } from '../email-service.js';
import { syncProfileCore } from './sync-profile-core.js';

export default async function syncProfile(req, res) {
  if (req.method !== 'POST') {
    return methodNotAllowed(res, 'POST');
  }

  const user = await requireUser(req);
  const body = req.body && typeof req.body === 'object' ? req.body : {};
  // NOTE: emailVerified on users/{uid} is derived server-side inside
  // syncProfileCore from the verified token (email_verified claim / Google
  // provider) — never from the request body.
  const result = await syncProfileCore(
    { db: adminDb, waitUntil, sendTelegramMessage, deliverQueuedEmailInline },
    user,
    body,
  );

  return res.status(200).json(result);
}
