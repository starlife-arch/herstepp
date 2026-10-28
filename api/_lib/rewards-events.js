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

    // Buyer earns only when every marketplace seller on the paid order has
    // marked their own items delivered. The deterministic key prevents repeats.
    const buyerUid = String(order.customerId || '').trim();
    const allSellers = [...new Set((Array.isArray(order.items) ? order.items : []).map(sellerOf).filter(Boolean))];
    const buyerEligible = buyerUid && allSellers.length > 0 && allSellers.every(uid =>
      String(uid === sellerUid ? 'DELIVERED' : order.sellerFulfilment?.[uid]?.status || '').toUpperCase() === 'DELIVERED'
    );
    if (buyerEligible) {
      const buyerLedgerRef = adminDb.collection('rewardLedger').doc(Buffer.from(`buyer-order-delivery:${orderDocumentId}`).toString('base64url'));
      const buyerAccountRef = adminDb.collection('rewardAccounts').doc(buyerUid);
      const [buyerEntrySnap, buyerAccountSnap] = await Promise.all([tx.get(buyerLedgerRef), tx.get(buyerAccountRef)]);
      if (!buyerEntrySnap.exists && config.buyer?.enabled !== false) {
        const eligibleSpend = Math.max(0, Number(order.subtotal ?? order.itemsSubtotal ?? allSellers.reduce((sum, uid) => sum + (Array.isArray(order.items) ? order.items.filter(item => sellerOf(item) === uid).reduce((s, item) => s + lineAmount(item), 0) : 0), 0)) || 0);
        const buyerPoints = safePoints(eligibleSpend, config.pointsPerKes, config.buyer?.maxPointsPerOrder);
        if (buyerPoints > 0) {
          const buyerOldBalance = Math.max(0, Number(buyerAccountSnap.data()?.pointsBalance) || 0);
          tx.create(buyerLedgerRef, {
            uid: buyerUid, accountType: 'BUYER', type: 'EARN', points: buyerPoints,
            amountKes: eligibleSpend, reason: 'Completed, paid marketplace order',
            orderId: order.orderId || orderDocumentId, orderDocumentId, status: 'POSTED',
            idempotencyKey: buyerLedgerRef.id, createdAt: now, ...(expiry ? { expiresAt: expiry } : {})
          });
          tx.set(buyerAccountRef, { uid: buyerUid, pointsBalance: buyerOldBalance + buyerPoints, updatedAt: now }, { merge: true });
        }
      }
    }
  });
}
