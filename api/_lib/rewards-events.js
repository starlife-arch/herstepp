import { FieldValue, Timestamp } from 'firebase-admin/firestore';
import { adminDb } from './firebase-admin.js';
import { calculateOutstandingLiability, pointsAllowedUnderLiabilityCap } from './rewards-liability.js';

const safePoints = (amount, rate, cap) => Math.max(0, Math.min(
  Math.floor(Math.max(0, Number(amount) || 0) * Math.max(0, Number(rate) || 0)),
  Math.max(0, Math.floor(Number(cap) || 0))
));
const expiration = days => Number(days) > 0 ? Timestamp.fromDate(new Date(Date.now() + Number(days) * 86400000)) : null;
const sellerOf = item => String(item?.sellerId || item?.sellerSnapshot?.sellerId || '').trim();
const lineAmount = item => Math.max(0, Number(item?.lineTotal ?? item?.total ?? ((Number(item?.unitPrice) || 0) * (Number(item?.quantity) || 0))) || 0);

/**
 * Award points after a seller records DELIVERED. This function independently
 * re-reads the paid order and current config and uses deterministic ledger IDs
 * so retries cannot award the same event twice.
 */
export async function awardMarketplaceDeliveryRewards(orderDocumentId, sellerUid, db = adminDb) {
  const orderRef = db.collection('orders').doc(orderDocumentId);
  const configRef = db.collection('rewardsConfig').doc('current');
  const sellerAccountRef = db.collection('rewardAccounts').doc(sellerUid);
  const sellerLedgerRef = db.collection('rewardLedger').doc(Buffer.from(`seller-delivery:${orderDocumentId}:${sellerUid}`).toString('base64url'));
  await db.runTransaction(async tx => {
    const [orderSnap, configSnap, sellerAccountSnap, sellerEntrySnap, ledgerSnap] = await Promise.all([
      tx.get(orderRef), tx.get(configRef), tx.get(sellerAccountRef), tx.get(sellerLedgerRef), tx.get(db.collection('rewardLedger').where('status', '==', 'POSTED'))
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
    const outstandingKes = calculateOutstandingLiability(ledgerSnap.docs.map(doc => doc.data()), config.pointValueKes);
    const points = pointsAllowedUnderLiabilityCap(requestedPoints, config.maxLiabilityKes, outstandingKes, config.pointValueKes);
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
    tx.set(configRef, { outstandingLiabilityKes: outstandingKes + points * Math.max(0.001, Number(config.pointValueKes) || 0.1), liabilityUpdatedAt: now }, { merge: true });

  });
  // Buyer points are awarded in a separate idempotent transaction only after
  // every seller on the paid order has marked their fulfilment delivered.
  const buyerLedgerRef = db.collection('rewardLedger').doc(Buffer.from(`buyer-order-delivery:${orderDocumentId}`).toString('base64url'));
  await db.runTransaction(async tx => {
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists) return;
    const order = orderSnap.data() || {};
    const buyerUid = String(order.customerId || '').trim();
    if (!buyerUid || String(order.paymentStatus || '').toUpperCase() !== 'PAID') return;
    const items = Array.isArray(order.items) ? order.items : [];
    if (!items.length) return;
    const sellerIds = [...new Set(items.map(sellerOf).filter(Boolean))];
    const sellerItemsDelivered = sellerIds.every(uid =>
      String(order.sellerFulfilment?.[uid]?.status || '').toUpperCase() === 'DELIVERED'
    );
    const hasFirstPartyItems = items.some(item => !sellerOf(item));
    const firstPartyDelivered = !hasFirstPartyItems
      || String(order.firstPartyFulfilment?.status || '').toUpperCase() === 'DELIVERED';
    if (!sellerItemsDelivered || !firstPartyDelivered) return;
    const buyerAccountRef = db.collection('rewardAccounts').doc(buyerUid);
    const configRef = db.collection('rewardsConfig').doc('current');
    const [configSnap, accountSnap, entrySnap, ledgerSnap] = await Promise.all([tx.get(configRef), tx.get(buyerAccountRef), tx.get(buyerLedgerRef), tx.get(db.collection('rewardLedger'))]);
    if (entrySnap.exists) return;
    const config = configSnap.data() || {};
    if (config.enabled !== true || config.buyer?.enabled === false) return;
    const spend = items.reduce((sum, item) => sum + lineAmount(item), 0);
    const requestedPoints = safePoints(spend, config.pointsPerKes, config.buyer?.maxPointsPerOrder);
    const outstandingKes = calculateOutstandingLiability(ledgerSnap.docs.map(doc => doc.data()), config.pointValueKes);
    const points = pointsAllowedUnderLiabilityCap(requestedPoints, config.maxLiabilityKes, outstandingKes, config.pointValueKes);
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
    tx.set(configRef, { outstandingLiabilityKes: outstandingKes + points * Math.max(0.001, Number(config.pointValueKes) || 0.1), liabilityUpdatedAt: now }, { merge: true });
  });
}
