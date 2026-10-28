import { FieldValue } from 'firebase-admin/firestore';
import { adminDb } from './firebase-admin.js';
import { calculateOutstandingLiability } from './rewards-liability.js';

const stamp = db => typeof db.__serverTimestamp === 'function' ? db.__serverTimestamp() : FieldValue.serverTimestamp();

export async function restoreRedeemedPointsAfterRefund(orderDocumentId, db = adminDb) {
  return db.runTransaction(async tx => {
    const [redeemed, configSnap, posted] = await Promise.all([
      tx.get(db.collection('rewardLedger').where('orderDocumentId', '==', orderDocumentId).where('status', '==', 'POSTED').where('type', '==', 'REDEEM')),
      tx.get(db.collection('rewardsConfig').doc('current')),
      tx.get(db.collection('rewardLedger').where('status', '==', 'POSTED')),
    ]);
    const originals = redeemed.docs.filter(doc => Number(doc.data()?.points) < 0);
    if (!originals.length) return { restored: 0 };
    const restoreRefs = originals.map(doc => db.collection('rewardLedger').doc(Buffer.from('refund-redemption:' + doc.id).toString('base64url')));
    const uids = [...new Set(originals.map(doc => String(doc.data()?.uid || '').trim()).filter(Boolean))];
    const accountRefs = uids.map(uid => db.collection('rewardAccounts').doc(uid));
    const reads = await Promise.all([...restoreRefs.map(ref => tx.get(ref)), ...accountRefs.map(ref => tx.get(ref))]);
    const existing = reads.slice(0, restoreRefs.length);
    const accounts = new Map(reads.slice(restoreRefs.length).map(snap => [snap.id, snap]));
    const liabilityEntries = posted.docs.map(doc => doc.data());
    let restored = 0;
    for (let i = 0; i < originals.length; i += 1) {
      if (existing[i].exists) continue;
      const original = originals[i].data() || {};
      const uid = String(original.uid || '').trim();
      const points = Math.abs(Math.floor(Number(original.points) || 0));
      if (!uid || !points) continue;
      const account = accounts.get(uid)?.data() || {};
      tx.create(restoreRefs[i], {
        uid, accountType: original.accountType || 'BUYER', type: 'REDEEM_REFUND_RESTORE', points,
        amountKes: Number(original.amountKes) || 0, reason: 'Points restored after verified order refund',
        orderDocumentId, orderId: original.orderId || orderDocumentId, reversesLedgerId: originals[i].id,
        status: 'POSTED', idempotencyKey: restoreRefs[i].id, createdAt: stamp(db),
      });
      tx.set(db.collection('rewardAccounts').doc(uid), {
        uid, pointsBalance: Math.max(0, Number(account.pointsBalance) || 0) + points, updatedAt: stamp(db),
      }, { merge: true });
      liabilityEntries.push({ status: 'POSTED', points });
      restored += 1;
    }
    if (restored) {
      const config = configSnap.data() || {};
      tx.set(db.collection('rewardsConfig').doc('current'), {
        outstandingLiabilityKes: calculateOutstandingLiability(liabilityEntries, config.pointValueKes),
        liabilityUpdatedAt: stamp(db),
      }, { merge: true });
    }
    return { restored };
  });
}
