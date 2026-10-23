import { FieldValue } from 'firebase-admin/firestore';
import { adminDb } from '../_lib/firebase-admin.js';
import { getPrintPayB2CPayoutStatus } from '../_lib/printpay-b2c.js';

const clean = (value, max = 180) => typeof value === 'string' ? value.trim().slice(0, max) : '';

function authorized(req) {
  const secret = clean(process.env.CRON_SECRET, 500);
  return Boolean(secret) && req.headers.authorization === `Bearer ${secret}`;
}

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed.' });
  }
  if (!authorized(req)) return res.status(401).json({ ok: false, error: 'Unauthorized.' });

  const snapshot = await adminDb.collection('sellerPayouts').where('status', '==', 'PROCESSING').limit(100).get();
  const results = [];
  for (const payoutDoc of snapshot.docs) {
    const payout = payoutDoc.data() || {};
    const conversationId = clean(payout.printPayConversationId, 180);
    if (!conversationId) {
      results.push({ payoutId: payoutDoc.id, outcome: 'missing_conversation_id' });
      continue;
    }

    let provider;
    try {
      provider = await getPrintPayB2CPayoutStatus({ conversationId });
    } catch (error) {
      console.error('[printpay-payout-reconcile] status lookup failed', { payoutId: payoutDoc.id, message: clean(error?.providerMessage || error?.message, 250) });
      results.push({ payoutId: payoutDoc.id, outcome: 'status_lookup_failed' });
      continue;
    }
    if (!provider.terminal) {
      results.push({ payoutId: payoutDoc.id, outcome: provider.transactionStatus || 'PROCESSING' });
      continue;
    }

    const ref = adminDb.collection('sellerPayouts').doc(payoutDoc.id);
    const ledgerRef = adminDb.collection('sellerLedger').doc(Buffer.from('marketplace-payout:' + payoutDoc.id).toString('base64url'));
    try {
      await adminDb.runTransaction(async tx => {
        const [freshSnap, ledgerSnap] = await Promise.all([tx.get(ref), tx.get(ledgerRef)]);
        if (!freshSnap.exists) return;
        const fresh = freshSnap.data() || {};
        const currentStatus = String(fresh.status || '').toUpperCase();
        if (currentStatus === 'PAID') return;
        if (currentStatus !== 'PROCESSING' || fresh.printPayConversationId !== conversationId) return;

        if (provider.transactionStatus === 'COMPLETED') {
          if (!provider.receipt) throw new Error('PrintPay reports COMPLETED but returned no M-Pesa receipt.');
          const fee = Number.isSafeInteger(fresh.printPayFeeBreakdown?.fee) && fresh.printPayFeeBreakdown.fee >= 0 ? fresh.printPayFeeBreakdown.fee : 0;
          const amount = Number(fresh.amount);
          if (!Number.isSafeInteger(amount) || amount < 1) throw new Error('Invalid payout amount; refusing to post ledger.');
          if (!ledgerSnap.exists) {
            tx.create(ledgerRef, {
              sellerId: fresh.sellerId, type: 'SELLER_PAYOUT', status: 'POSTED',
              amount: -(amount + fee), transferAmount: amount, providerFee: fee, totalDebit: amount + fee,
              currency: fresh.currency || 'KES', balanceBucket: 'AVAILABLE', payoutId: payoutDoc.id,
              providerReference: provider.receipt, idempotencyKey: ledgerRef.id, createdAt: FieldValue.serverTimestamp(),
            });
          }
          tx.update(ref, {
            status: 'PAID', providerReference: provider.receipt,
            printPayProviderStatus: provider.transactionStatus, printPayResultCode: provider.resultCode,
            printPayResultDescription: provider.resultDescription, printPayFinalStatusVerified: true,
            paidAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(),
          });
          tx.set(adminDb.collection('sellerMarketplaceAudit').doc(), {
            sellerUid: fresh.sellerId, sellerId: fresh.sellerId, actorUid: 'SYSTEM', action: 'SELLER_PAYOUT_PAID',
            payoutId: payoutDoc.id, amount, currency: fresh.currency || 'KES', status: 'PAID',
            providerReference: provider.receipt, providerConversationId: conversationId, createdAt: FieldValue.serverTimestamp(),
          });
          tx.set(adminDb.collection('auditLogs').doc(), {
            actorUid: 'SYSTEM', action: 'SELLER_PAYOUT_PRINTPAY_CONFIRMED', entityType: 'SELLER_PAYOUT',
            entityId: payoutDoc.id, amount, providerReference: provider.receipt, providerConversationId: conversationId,
            resultCode: provider.resultCode, createdAt: FieldValue.serverTimestamp(),
          });
          return;
        }

        const nextStatus = provider.transactionStatus === 'REVERSED' ? 'REVERSED' : 'FAILED';
        tx.update(ref, {
          status: nextStatus, printPayProviderStatus: provider.transactionStatus,
          printPayResultCode: provider.resultCode, printPayResultDescription: provider.resultDescription,
          printPayFinalStatusVerified: true,
          printPayDispatchError: provider.resultDescription || `PrintPay payout status: ${provider.transactionStatus}`,
          updatedAt: FieldValue.serverTimestamp(),
        });
        tx.set(adminDb.collection('sellerMarketplaceAudit').doc(), {
          sellerUid: fresh.sellerId, sellerId: fresh.sellerId, actorUid: 'SYSTEM',
          action: nextStatus === 'REVERSED' ? 'SELLER_PAYOUT_REVERSED' : 'SELLER_PAYOUT_FAILED',
          payoutId: payoutDoc.id, amount: Number(fresh.amount) || 0, currency: fresh.currency || 'KES',
          status: nextStatus, providerConversationId: conversationId, reason: provider.resultDescription,
          createdAt: FieldValue.serverTimestamp(),
        });
        tx.set(adminDb.collection('auditLogs').doc(), {
          actorUid: 'SYSTEM', action: nextStatus === 'REVERSED' ? 'SELLER_PAYOUT_PRINTPAY_REVERSED' : 'SELLER_PAYOUT_PRINTPAY_FAILED',
          entityType: 'SELLER_PAYOUT', entityId: payoutDoc.id, amount: Number(fresh.amount) || 0,
          providerConversationId: conversationId, resultCode: provider.resultCode, createdAt: FieldValue.serverTimestamp(),
        });
      });
      results.push({ payoutId: payoutDoc.id, outcome: provider.transactionStatus });
    } catch (error) {
      console.error('[printpay-payout-reconcile] failed to persist verified payout status', { payoutId: payoutDoc.id, message: clean(error?.message, 250) });
      results.push({ payoutId: payoutDoc.id, outcome: 'persistence_failed' });
    }
  }
  return res.status(200).json({ ok: true, checked: snapshot.size, results });
}
