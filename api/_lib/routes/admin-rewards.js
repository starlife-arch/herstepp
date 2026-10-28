import { FieldValue } from 'firebase-admin/firestore';
import { adminDb, requireAdmin } from '../firebase-admin.js';
import { clientError, methodNotAllowed } from '../http.js';

const defaults = {
  enabled: false, pointsPerKes: 1, pointValueKes: 0.1, expiryDays: 365, maxLiabilityKes: 100000,
  buyer: { enabled: true, earnOn: 'COMPLETED_PAID_ORDER', maxPointsPerOrder: 5000, redemptionEnabled: false, maxRedemptionPercent: 20, minRedeemPoints: 100 },
  seller: { enabled: true, earnOn: 'VERIFIED_COMPLETED_SALE', maxPointsPerOrder: 5000, redemptionEnabled: false, redemptionTargets: ['SELLER_PLAN', 'AI_TOKENS', 'PROMOTIONS'], minRedeemPoints: 100 }
};
const number = (v, fallback, min, max) => {
  const n = Number(v ?? fallback);
  if (!Number.isFinite(n) || n < min || n > max) throw clientError(`Value must be between ${min} and ${max}.`);
  return n;
};
const normalize = (input, previous = defaults) => {
  const p = input || {};
  const b = p.buyer || previous.buyer;
  const s = p.seller || previous.seller;
  if (b.earnOn !== 'COMPLETED_PAID_ORDER') throw clientError('Buyer rewards must be based on completed, paid orders.');
  if (s.earnOn !== 'VERIFIED_COMPLETED_SALE') throw clientError('Seller rewards must be based on verified completed sales.');
  const targets = Array.isArray(s.redemptionTargets) ? [...new Set(s.redemptionTargets)] : previous.seller.redemptionTargets;
  if (targets.some(v => !['SELLER_PLAN', 'AI_TOKENS', 'PROMOTIONS'].includes(v))) throw clientError('Choose valid seller redemption options.');
  return {
    enabled: p.enabled === true,
    pointsPerKes: number(p.pointsPerKes, previous.pointsPerKes, 0, 100),
    pointValueKes: number(p.pointValueKes, previous.pointValueKes, 0.001, 10),
    expiryDays: Math.floor(number(p.expiryDays, previous.expiryDays, 0, 3650)),
    maxLiabilityKes: Math.floor(number(p.maxLiabilityKes, previous.maxLiabilityKes, 0, 1000000000)),
    buyer: { enabled: b.enabled !== false, earnOn: 'COMPLETED_PAID_ORDER', maxPointsPerOrder: Math.floor(number(b.maxPointsPerOrder, previous.buyer.maxPointsPerOrder, 0, 1000000)), redemptionEnabled: b.redemptionEnabled === true, maxRedemptionPercent: number(b.maxRedemptionPercent, previous.buyer.maxRedemptionPercent, 0, 80), minRedeemPoints: Math.floor(number(b.minRedeemPoints, previous.buyer.minRedeemPoints, 1, 100000000)) },
    seller: { enabled: s.enabled !== false, earnOn: 'VERIFIED_COMPLETED_SALE', maxPointsPerOrder: Math.floor(number(s.maxPointsPerOrder, previous.seller.maxPointsPerOrder, 0, 1000000)), redemptionEnabled: s.redemptionEnabled === true, redemptionTargets: targets, minRedeemPoints: Math.floor(number(s.minRedeemPoints, previous.seller.minRedeemPoints, 1, 100000000)) }
  };
};
export default async function adminRewards(req, res) {
  const admin = await requireAdmin(req);
  const ref = adminDb.collection('rewardsConfig').doc('current');
  if (req.method === 'GET') {
    const snap = await ref.get();
    const d = snap.data() || {};
    return res.status(200).json({ config: { ...defaults, ...d, buyer: { ...defaults.buyer, ...(d.buyer || {}) }, seller: { ...defaults.seller, ...(d.seller || {}) }, updatedAt: d.updatedAt?.toDate?.()?.toISOString?.() || null } });
  }
  if (req.method !== 'PATCH') return methodNotAllowed(res, 'GET, PATCH');
  const snap = await ref.get();
  const d = snap.data() || {};
  const previous = { ...defaults, ...d, buyer: { ...defaults.buyer, ...(d.buyer || {}) }, seller: { ...defaults.seller, ...(d.seller || {}) } };
  const next = normalize(req.body, previous);
  const now = FieldValue.serverTimestamp();
  await adminDb.runTransaction(async tx => {
    const fresh = await tx.get(ref);
    const current = fresh.data() || {};
    const old = { ...defaults, ...current, buyer: { ...defaults.buyer, ...(current.buyer || {}) }, seller: { ...defaults.seller, ...(current.seller || {}) } };
    const validated = normalize(req.body, old);
    tx.set(ref, { ...validated, updatedAt: now, updatedBy: admin.uid }, { merge: true });
    tx.set(adminDb.collection('auditLogs').doc(), { adminId: admin.uid, adminName: admin.displayName || admin.email || '', action: 'REWARDS_CONFIG_UPDATED', targetType: 'rewardsConfig', targetId: 'current', previous: current, next: validated, createdAt: now });
  });
  return res.status(200).json({ success: true, message: 'Rewards rules saved. The rewards programme remains off until enabled.', config: next });
}
