// HTTP wrapper for GET /api/invoices/download?orderDocumentId= — dispatched from
// api/orders.js (?route=invoices/download) via a vercel.json rewrite. All logic
// lives in invoice-core.js so the strict fake-DB tests can run it directly.
import { waitUntil } from '@vercel/functions';
import { adminDb, requireUser } from '../firebase-admin.js';
import { methodNotAllowed, sendError } from '../http.js';
import { downloadInvoiceCore } from './invoice-core.js';

export default async function invoicesDownload(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
  try {
    const user = await requireUser(req);
    const qv = k => (Array.isArray(req.query[k]) ? req.query[k][0] : req.query[k]);
    const out = await downloadInvoiceCore({
      db: adminDb,
      uid: user.uid,
      token: user.token,
      orderDocumentId: qv('orderDocumentId'),
    });
    res.status(out.status);
    for (const [k, v] of Object.entries(out.headers)) res.setHeader(k, v);
    waitUntil(Promise.resolve());
    return res.send(out.body);
  } catch (error) {
    return sendError(res, error);
  }
}
