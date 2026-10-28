import { adminDb, requireUser } from '../firebase-admin.js';
import { methodNotAllowed } from '../http.js';

const iso = value => value?.toDate?.()?.toISOString?.() || null;
export default async function rewardsAccount(req, res) {
  const user = await requireUser(req);
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
  const accountRef = adminDb.collection('rewardAccounts').doc(user.uid);
  const ledgerQuery = adminDb.collection('rewardLedger').where('uid', '==', user.uid);
  const [configSnap, accountSnap, ledgerSnap, sellerSnap] = await Promise.all([
    adminDb.collection('rewardsConfig').doc('current').get(),
    accountRef.get(),
    ledgerQuery.get(),
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
  let storedPointsBalance = Math.max(0, Number(account.pointsBalance) || 0);
  const pointsBalance = Math.max(0, ledgerBalance);
  // A legacy redemption path wrote the REDEEM ledger entry but left the cached
  // account balance unchanged. Reconcile only when the cache exactly matches
  // the sum of positive posted awards and the entire difference is explained
  // by posted negative REDEEM entries. Never silently erase unexplained points.
  const positiveAwards = entries.reduce((sum, e) => sum + (e.status === 'POSTED' && !e.expired && e.points > 0 ? e.points : 0), 0);
  const postedRedemptions = entries.filter(e => e.status === 'POSTED' && !e.expired && e.points < 0);
  const allDebitsAreRedemptions = postedRedemptions.every(e => e.type === 'REDEEM');
  const redemptionExplainsDifference = postedRedemptions.length > 0 && allDebitsAreRedemptions && storedPointsBalance === positiveAwards && positiveAwards + postedRedemptions.reduce((sum, e) => sum + e.points, 0) === ledgerBalance;
  if (storedPointsBalance !== pointsBalance && redemptionExplainsDifference) {
    await adminDb.runTransaction(async tx => {
      const freshAccountSnap = await tx.get(accountRef);
      const freshLedgerSnap = await tx.get(ledgerQuery);
      const freshAccount = freshAccountSnap.data() || {};
      const freshEntries = freshLedgerSnap.docs.map(doc => doc.data() || {});
      const freshNow = Date.now();
      const expiryMs = e => e.expiresAt?.toMillis?.() ?? e.expiresAt?.toDate?.()?.getTime?.() ?? (e.expiresAt instanceof Date ? e.expiresAt.getTime() : null);
      const activeEntries = freshEntries.filter(e => String(e.status || 'POSTED') === 'POSTED' && !(Number(e.points) > 0 && expiryMs(e) != null && expiryMs(e) <= freshNow));
      const freshBalance = activeEntries.reduce((sum, e) => sum + (Number(e.points) || 0), 0);
      const freshPositive = activeEntries.reduce((sum, e) => sum + (Number(e.points) > 0 ? Number(e.points) : 0), 0);
      const freshDebits = activeEntries.filter(e => Number(e.points) < 0);
      const freshDebitsAreRedemptions = freshDebits.length > 0 && freshDebits.every(e => e.type === 'REDEEM');
      if (Number(freshAccount.pointsBalance || 0) === freshPositive && freshDebitsAreRedemptions && freshBalance === freshPositive + freshDebits.reduce((sum, e) => sum + Number(e.points), 0)) {
        tx.set(accountRef, { pointsBalance: Math.max(0, freshBalance), updatedAt: new Date() }, { merge: true });
        storedPointsBalance = Math.max(0, freshBalance);
      }
    });
  }
  return res.status(200).json({ enabled: config.enabled === true, accountType: seller ? 'SELLER' : 'BUYER', pointsBalance, storedPointsBalance, ledgerBalance, balanceMismatch: storedPointsBalance !== pointsBalance, pointValueKes: Number(config.pointValueKes) || 0, estimatedValueKes: Math.round(pointsBalance * (Number(config.pointValueKes) || 0) * 100) / 100, expiryDays: Number(config.expiryDays) || 0, redemptionEnabled: config.enabled === true && (seller ? config.seller?.redemptionEnabled === true : config.buyer?.redemptionEnabled === true), minRedeemPoints: Math.max(1, Number(seller ? config.seller?.minRedeemPoints : config.buyer?.minRedeemPoints) || 100), maxRedemptionPercent: seller ? null : Math.min(80, Math.max(1, Number(config.buyer?.maxRedemptionPercent) || 20)), redemptionTargets: seller && Array.isArray(config.seller?.redemptionTargets) ? config.seller.redemptionTargets : [], entries, message: config.enabled === true ? null : 'Rewards are not active yet.' });
}
