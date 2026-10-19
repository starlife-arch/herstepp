import { adminDb, requireUser } from '../firebase-admin.js';
import { methodNotAllowed } from '../http.js';
import { getSellerEntitlements } from '../seller-entitlements-core.js';

export default async function sellerEntitlements(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
  const user = await requireUser(req);
  const entitlements = await getSellerEntitlements(adminDb, user.uid);
  return res.status(200).json({ entitlements, publishingEnabled: false });
}
