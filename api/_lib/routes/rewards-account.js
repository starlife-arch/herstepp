import { adminDb, requireUser } from '../firebase-admin.js';
import { methodNotAllowed } from '../http.js';

const iso = value => value?.toDate?.()?.toISOString?.() || null;
export default async function rewardsAccount(req, res) {
  const user = await requireUser(req);
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
  const [configSnap, accountSnap, ledgerSnap, sellerSnap] = await Promise.all([
    adminDb.collection('rewardsConfig').doc('current').get(),
    adminDb.collection('rewardAccounts').doc(user.uid).get(),
    adminDb.collection('rewardLedger').where('uid', '==', user.uid).get(),
    adminDb.collection('sellers').doc(user.uid).get(),
  ]);
  const config = configSnap.data() || { enabled: false, pointValueKes: 0.1, buyer: { enabled: true }, seller: { enabled: true } };
  const account = accountSnap.data() || {};
  const now = Date.now();
  const entries = ledgerSnap.docs.map(doc => {
    const d = doc.data() || {};
    const expiresAt = iso(d.expiresAt);
    const expired = expiresAt ? new Date(expiresAt).getTime() <= now : false;
    return { id: doc.id, type: d.type || 'UNKNOWN', points: Number(d.points) || 0, reason: String(d.reason || ''), orderId: d.orderId || null, createdAt: iso(d.createdAt), expiresAt, expired, status: d.status || 'POSTED' };
  }).sort((a,b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const ledgerBalance = entries.reduce((sum, e) => sum + (e.status === 'POSTED' && !e.expired ? e.points : 0), 0);
  const seller = sellerSnap.exists && ['ACTIVE', 'PENDING'].includes(String(sellerSnap.data()?.status || '').toUpperCase());
  const storedPointsBalance = Math.max(0, Number(account.pointsBalance) || 0);
  const pointsBalance = Math.max(0, ledgerBalance);
  return res.status(200).json({ enabled: config.enabled === true, accountType: seller ? 'SELLER' : 'BUYER', pointsBalance, storedPointsBalance, ledgerBalance, balanceMismatch: storedPointsBalance !== pointsBalance, pointValueKes: Number(config.pointValueKes) || 0, estimatedValueKes: Math.round(pointsBalance * (Number(config.pointValueKes) || 0) * 100) / 100, expiryDays: Number(config.expiryDays) || 0, redemptionEnabled: config.enabled === true && (seller ? config.seller?.redemptionEnabled === true : config.buyer?.redemptionEnabled === true), minRedeemPoints: Math.max(1, Number(seller ? config.seller?.minRedeemPoints : config.buyer?.minRedeemPoints) || 100), maxRedemptionPercent: seller ? null : Math.min(80, Math.max(1, Number(config.buyer?.maxRedemptionPercent) || 20)), redemptionTargets: seller && Array.isArray(config.seller?.redemptionTargets) ? config.seller.redemptionTargets : [], entries, message: config.enabled === true ? null : 'Rewards are not active yet.' });
}
