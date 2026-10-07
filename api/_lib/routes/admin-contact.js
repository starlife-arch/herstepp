// Admin HTTP wrappers for the contact-message inbox. requireAdmin guards every
// route; core logic lives in contact-core.js (unit-tested offline).
import { waitUntil } from '@vercel/functions';
import { adminDb, requireAdmin } from '../firebase-admin.js';
import { methodNotAllowed } from '../http.js';
import { listContactMessages, updateContactStatus, replyContactMessage } from './contact-core.js';

// GET /api/admin/contact-messages?status=&cursor=
export async function adminList(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
  await requireAdmin(req);
  const status = typeof req.query?.status === 'string' && req.query.status ? req.query.status : null;
  const cursor = typeof req.query?.cursor === 'string' && req.query.cursor ? req.query.cursor : null;
  const result = await listContactMessages({ db: adminDb, status, cursor });
  return res.json(result);
}

// PATCH /api/admin/contact-messages { id, status }
export async function adminStatus(req, res) {
  if (req.method !== 'PATCH') return methodNotAllowed(res, 'PATCH');
  const admin = await requireAdmin(req);
  const { id, status } = req.body || {};
  const result = await updateContactStatus({ db: adminDb, admin, id, status });
  return res.json(result);
}

// POST /api/admin/contact-messages/reply { id, body }
export async function adminReply(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
  const admin = await requireAdmin(req);
  const { id, body } = req.body || {};
  const result = await replyContactMessage({ db: adminDb, admin, id, body, waitUntil });
  return res.json(result);
}
