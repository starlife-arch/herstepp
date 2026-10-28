import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { adminDb } from './firebase-admin.js';

const safePoints = (amount, rate, cap) => Math.max(0, Math.min(
  Math.floor(Math.max(0, Number(amount) || 0) * Math.max(0, Number(rate) || 0)),
  Math.max(0, Math.floor(Number(cap) || 0))
));
const liabilityPoints = (requested, config, outstandingKes) => {
  const pointValue = Math.max(0.001, Number(config.pointValueKes) || 0.1);
  const capKes = Math.max(0, Number(config.maxLiabilityKes) || 0);
  const availableKes = Math.max(0, capKes - Math.max(0, Number(outstandingKes) || 0));
  return Math.max(0, Math.min(Math.floor(Number(requested) || 0), Math.floor((availableKes + 1e-9) / pointValue)));
};
const expiration = days => Number(days) > 0 ? Timestamp.fromDate(new Date(Date.now() + Number(days) * 86400000)) : null;
const sellerOf = item => String(item?.sellerId || item?.sellerSnapshot?.sellerId || '').trim();
const lineAmount = item => Math.max(0, Number(item?.lineTotal ?? item?.total ?? ((Number(item?.unitPrice) || 0) * (Number(item?.quantity) || 0))) || 0);

/**
 * Award points after a seller records DELIVERED. This function independently
 * re-reads the paid order and current config and uses deterministic ledger IDs
 * so retries cannot award the same event twice.
 */
export async function awardMarketplaceDeliveryRewards(orderDocumentId, sellerUid) {
  const orderRef = adminDb.collection('orders').doc(orderDocumentId);
  const configRef = adminDb.collection('rewardsConfig').doc('current');
  const sellerAccountRef = adminDb.collection('rewardAccounts').doc(sellerUid);
  const sellerLedgerRef = adminDb.collection('rewardLedger').doc(Buffer.from(`seller-delivery:${orderDocumentId}:${sellerUid}`).toString('base64url'));
  await adminDb.runTransaction(async tx => {
    const [orderSnap, configSnap, sellerAccountSnap, sellerEntrySnap] = await Promise.all([
      tx.get(orderRef), tx.get(configRef), tx.get(sellerAccountRef), tx.get(sellerLedgerRef)
    ]);
    if (!orderSnap.exists || sellerEntrySnap.exists) return;
    const order = orderSnap.data() || {};
    const config = configSnap.data() || {};
    if (config.enabled !== true || config.seller?.enabled === false) return;
    if (String(order.paymentStatus || '').toUpperCase() !== 'PAID') return;
    if (String(order.sellerFulfilment?.[sellerUid]?.status || '').toUpperCase() !== 'DELIVERED') return;
    const ownItems = (Array.isArray(order.items) ? order.items : []).filter(item => sellerOf(item) === sellerUid);
    if (!ownItems.length) return;
    const gross = ownItems.reduce((sum, item) => sum + lineAmount(item), 0);
    const requestedPoints = safePoints(gross, config.pointsPerKes, config.seller?.maxPointsPerOrder);
    const points = liabilityPoints(requestedPoints, config, config.outstandingLiabilityKes);
    if (!points) return;
    const now = FieldValue.serverTimestamp();
    const expiry = expiration(config.expiryDays);
    const oldBalance = Math.max(0, Number(sellerAccountSnap.data()?.pointsBalance) || 0);
    tx.create(sellerLedgerRef, {
      uid: sellerUid, accountType: 'SELLER', type: 'EARN', points, amountKes: gross,
      reason: 'Verified completed marketplace sale', orderId: order.orderId || orderDocumentId,
      orderDocumentId, status: 'POSTED', idempotencyKey: sellerLedgerRef.id,
      createdAt: now, ...(expiry ? { expiresAt: expiry } : {})
    });
    tx.set(sellerAccountRef, { uid: sellerUid, pointsBalance: oldBalance + points, updatedAt: now }, { merge: true });
    tx.set(configRef, { outstandingLiabilityKes: Math.max(0, Number(config.outstandingLiabilityKes) || 0) + points * Math.max(0.001, Number(config.pointValueKes) || 0.1), liabilityUpdatedAt: now }, { merge: true });

  });
  // Buyer points are awarded in a separate idempotent transaction only after
  // every seller on the paid order has marked their fulfilment delivered.
  const buyerLedgerRef = adminDb.collection('rewardLedger').doc(Buffer.from(`buyer-order-delivery:${orderDocumentId}`).toString('base64url'));
  await adminDb.runTransaction(async tx => {
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists) return;
    const order = orderSnap.data() || {};
    const buyerUid = String(order.customerId || '').trim();
    if (!buyerUid || String(order.paymentStatus || '').toUpperCase() !== 'PAID') return;
    const items = Array.isArray(order.items) ? order.items : [];
    const sellers = [...new Set(items.map(sellerOf).filter(Boolean))];
    if (!sellers.length || !sellers.every(uid => String(order.sellerFulfilment?.[uid]?.status || '').toUpperCase() === 'DELIVERED')) return;
    const buyerAccountRef = adminDb.collection('rewardAccounts').doc(buyerUid);
    const configRef = adminDb.collection('rewardsConfig').doc('current');
    const [configSnap, accountSnap, entrySnap] = await Promise.all([tx.get(configRef), tx.get(buyerAccountRef), tx.get(buyerLedgerRef)]);
    if (entrySnap.exists) return;
    const config = configSnap.data() || {};
    if (config.enabled !== true || config.buyer?.enabled === false) return;
    const spend = items.reduce((sum, item) => sum + lineAmount(item), 0);
    const requestedPoints = safePoints(spend, config.pointsPerKes, config.buyer?.maxPointsPerOrder);
    const points = liabilityPoints(requestedPoints, config, config.outstandingLiabilityKes);
    if (!points) return;
    const now = FieldValue.serverTimestamp();
    const expiry = expiration(config.expiryDays);
    tx.create(buyerLedgerRef, {
      uid: buyerUid, accountType: 'BUYER', type: 'EARN', points, amountKes: spend,
      reason: 'Completed, paid marketplace order', orderId: order.orderId || orderDocumentId,
      orderDocumentId, status: 'POSTED', idempotencyKey: buyerLedgerRef.id, createdAt: now,
      ...(expiry ? { expiresAt: expiry } : {})
    });
    tx.set(buyerAccountRef, { uid: buyerUid, pointsBalance: Math.max(0, Number(accountSnap.data()?.pointsBalance) || 0) + points, updatedAt: now }, { merge: true });
    tx.set(configRef, { outstandingLiabilityKes: Math.max(0, Number(config.outstandingLiabilityKes) || 0) + points * Math.max(0.001, Number(config.pointValueKes) || 0.1), liabilityUpdatedAt: now }, { merge: true });
  });
}
