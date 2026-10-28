import { FieldValue } from 'firebase-admin/firestore';
import { adminDb } from './firebase-admin.js';
import { calculateOutstandingLiability } from './rewards-liability.js';

/**
 * Reverses previously posted EARN entries for a refunded order exactly once.
 * The refund event itself must already have been verified by the payment
 * provider. This function never trusts a client-supplied refund status.
 */
export async function reverseMarketplaceOrderRewards(orderDocumentId, db = adminDb) {
  if (typeof orderDocumentId !== 'string' || !orderDocumentId) return { reversed: 0 };
  const orderRef = db.collection('orders').doc(orderDocumentId);
  return db.runTransaction(async tx => {
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists) return { reversed: 0, missingOrder: true };
    const order = orderSnap.data() || {};
    const [ledgerSnap, configSnap] = await Promise.all([
      tx.get(db.collection('rewardLedger').where('orderDocumentId', '==', orderDocumentId).where('status', '==', 'POSTED').where('type', '==', 'EARN')),
      tx.get(db.collection('rewardsConfig').doc('current')),
    ]);
    const awards = ledgerSnap.docs.filter(doc => Number(doc.data()?.points) > 0);
    if (!awards.length) return { reversed: 0 };
    const reversalRefs = awards.map(doc => db.collection('rewardLedger').doc(Buffer.from('refund:' + doc.id).toString('base64url')));
    const accountRefs = [...new Set(awards.map(doc => String(doc.data()?.uid || '').trim()).filter(Boolean))]
      .map(uid => db.collection('rewardAccounts').doc(uid));
    const reads = await Promise.all([...reversalRefs.map(ref => tx.get(ref)), ...accountRefs.map(ref => tx.get(ref))]);
    const existingReversals = reads.slice(0, reversalRefs.length);
    const accountSnaps = reads.slice(reversalRefs.length);
    const accountByUid = new Map(accountSnaps.map(snap => [snap.id, snap]));
    let reversed = 0;
    const resultingLedger = ledgerSnap.docs.map(doc => doc.data());
    for (let i = 0; i < awards.length; i += 1) {
      if (existingReversals[i].exists) continue;
      const award = awards[i].data() || {};
      const uid = String(award.uid || '').trim();
      if (!uid) continue;
      const points = Math.floor(Number(award.points) || 0);
      if (points <= 0) continue;
      const accountRef = db.collection('rewardAccounts').doc(uid);
      const account = accountByUid.get(uid)?.data() || {};
      tx.create(reversalRefs[i], {
        uid, accountType: award.accountType || 'BUYER', type: 'REFUND_REVERSAL',
        points: -points, reason: 'Reward points reversed after verified order refund',
        orderId: order.orderId || orderDocumentId, orderDocumentId,
        reversesLedgerId: awards[i].id, status: 'POSTED',
        idempotencyKey: reversalRefs[i].id, createdAt: FieldValue.serverTimestamp(),
      });
      tx.set(accountRef, {
        uid, pointsBalance: Math.max(0, Number(account.pointsBalance) - points || 0),
        updatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
      resultingLedger.push({ uid, type: 'REFUND_REVERSAL', points: -points, status: 'POSTED' });
      reversed += 1;
    }
    if (reversed) {
      const config = configSnap.data() || {};
      const liability = calculateOutstandingLiability(resultingLedger, config.pointValueKes);
      tx.set(db.collection('rewardsConfig').doc('current'), {
        outstandingLiabilityKes: liability, liabilityUpdatedAt: FieldValue.serverTimestamp(),
      }, { merge: true });
    }
    return { reversed };
  });
}
