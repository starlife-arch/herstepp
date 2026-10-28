import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { adminDb } from '../firebase-admin.js';

const safePoints = (amount, rate, cap) => Math.max(0, Math.min(Math.floor(Math.max(0, Number(amount) || 0) * Math.max(0, Number(rate) || 0)), Math.max(0, Math.floor(Number(cap) || 0))));
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
    const points = safePoints(gross, config.pointsPerKes, config.seller?.maxPointsPerOrder);
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

  });
}
