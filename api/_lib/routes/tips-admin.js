// GET /api/admin/tips — in-app tipping overview for the admin panel.
// Thin wrapper around api/_lib/tip-core.js adminTips(): newest first, phone
// masked to last 4 digits, totals computed ONLY from PAID tips, plus a
// best-effort reconciliation of stale PENDING tips before reading.
import { FieldValue } from 'firebase-admin/firestore';
import { adminDb, requireAdmin } from '../firebase-admin.js';
import { getMpesaProvider } from '../mpesa-provider.js';
import { methodNotAllowed } from '../http.js';
import { queueTipThankYouEmail } from '../notify.js';
import { adminTips, reconcilePendingTips } from '../tip-core.js';

export default async function tipsAdmin(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET');

  const deps = {
    db: adminDb,
    serverTimestamp: () => FieldValue.serverTimestamp(),
    provider: getMpesaProvider(),
    requireAdmin,
    queueTipThankYouEmail: (tx, payload) => queueTipThankYouEmail(tx, adminDb, payload),
  };

  // Best effort: settle dead prompts BEFORE listing so the admin never sees a
  // tip stuck in PENDING forever. Any failure is swallowed inside.
  await reconcilePendingTips(deps);

  const result = await adminTips(deps, req);
  return res.json(result);
}
