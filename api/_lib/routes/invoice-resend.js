// HTTP wrapper for POST /api/admin/invoices/resend — dispatched from
// api/admin.js (?route=invoices/resend). requireAdmin + all logic in
// invoice-core.js (strict fake-DB testable).
import { adminDb, requireAdmin } from '../firebase-admin.js';
import { methodNotAllowed, sendError } from '../http.js';
import { resendInvoiceCore } from './invoice-core.js';

export default async function invoicesResend(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
  try {
    const admin = await requireAdmin(req);
    const body = typeof req.body === 'object' && req.body ? req.body : {};
    const out = await resendInvoiceCore({
      db: adminDb,
      uid: admin.uid,
      orderDocumentId: body.orderDocumentId,
    });
    return res.status(200).json(out);
  } catch (error) {
    return sendError(res, error);
  }
}
