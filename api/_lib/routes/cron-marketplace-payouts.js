import { FieldValue } from 'firebase-admin/firestore';
import { adminDb } from '../firebase-admin.js';
import { getPrintPayB2CWalletBalance, initiatePrintPayB2CPayout } from '../printpay-b2c.js';
import { sendTelegramMessage } from '../telegram.js';

const FEE_BUFFER = 50;
const clean = (value, max = 300) => typeof value === 'string' ? value.trim().slice(0, max) : '';
function authorized(req) {
  const expected = String(process.env.CRON_SECRET || '').trim();
  const supplied = String(req.headers?.authorization || '').replace(/^Bearer\\s+/i, '').trim();
  return Boolean(expected && supplied.length === expected.length && supplied === expected);
}
function alertAdmin(message) {
  Promise.resolve(sendTelegramMessage(message)).catch(error => console.error('[cron-marketplace-payouts] alert failed:', error?.message || String(error)));
}

/**
 * Periodically dispatches only payouts already reserved in REQUESTED.
 * A transaction claims each payout before the external call. Unknown provider
 * outcomes are locked for reconciliation and are never automatically retried.
 */
export async function processRequestedMarketplacePayouts(req, res) {
  if (!['GET', 'POST'].includes(req.method)) return res.status(405).json({ error: 'Method not allowed.' });
  if (!authorized(req)) return res.status(401).json({ error: 'Unauthorized.' });

  let wallet;
  try {
    wallet = await getPrintPayB2CWalletBalance();
  } catch (error) {
    console.error('[cron-marketplace-payouts] wallet balance unavailable:', error?.message || String(error));
    return res.status(502).json({ ok: false, error: 'Wallet balance unavailable; no payouts were dispatched.' });
  }

  const snapshot = await adminDb.collection('sellerPayouts')
    .where('status', '==', 'REQUESTED')
    .limit(25)
    .get();
  let scanned = 0;
  let dispatched = 0;
  let skipped = 0;
  let available = Number(wallet.balance);

  for (const payoutDoc of snapshot.docs) {
    scanned += 1;
    const payoutRef = payoutDoc.ref;
    const payoutId = payoutDoc.id;
    let claimed = null;

    // Claim atomically. If an admin or another cron already claimed this
    // request, this worker must not call PrintPay.
    try {
      claimed = await adminDb.runTransaction(async tx => {
        const fresh = await tx.get(payoutRef);
        if (!fresh.exists) return null;
        const payout = fresh.data() || {};
        if (String(payout.status || '').toUpperCase() !== 'REQUESTED') return null;
        const amount = Number(payout.amount);
        if (!Number.isSafeInteger(amount) || amount < 10 || amount > 10_000_000 || !payout.payoutPhone || !payout.sellerId) {
          tx.update(payoutRef, {
            printPayDispatchError: 'Automatic dispatch skipped because payout details are incomplete or invalid.',
            updatedAt: FieldValue.serverTimestamp(),
          });
          return null;
        }
        if (available < amount + FEE_BUFFER) return { insufficient: true };
        tx.update(payoutRef, {
          status: 'DISPATCHING',
          printPayDispatchStartedAt: FieldValue.serverTimestamp(),
          printPayDispatchStartedBy: 'SYSTEM_CRON',
          printPayWalletBalanceAtDispatch: available,
          updatedAt: FieldValue.serverTimestamp(),
        });
        tx.set(adminDb.collection('auditLogs').doc(), {
          actorUid: 'SYSTEM_CRON', action: 'SELLER_PAYOUT_AUTO_DISPATCH_STARTED',
          entityType: 'SELLER_PAYOUT', entityId: payoutId, amount,
          createdAt: FieldValue.serverTimestamp(),
        });
        return {
          amount, phone: String(payout.payoutPhone),
          sellerId: String(payout.sellerId),
          sellerName: clean(payout.sellerName, 100) || 'Marketplace seller',
        };
      });
    } catch (error) {
      console.error('[cron-marketplace-payouts] could not claim payout:', payoutId, error?.message || String(error));
      skipped += 1;
      continue;
    }

    if (!claimed) { skipped += 1; continue; }
    if (claimed.insufficient) break;

    try {
      const result = await initiatePrintPayB2CPayout({
        payoutId, phone: claimed.phone, amount: claimed.amount,
      });
      await adminDb.runTransaction(async tx => {
        const fresh = await tx.get(payoutRef);
        if (!fresh.exists || fresh.data()?.status !== 'DISPATCHING') {
          throw new Error('Payout state changed after PrintPay initiation; manual reconciliation required.');
        }
        tx.update(payoutRef, {
          status: 'PROCESSING',
          printPayProvider: 'PRINTPAY',
          printPayProviderStatus: result.providerStatus,
          printPayConversationId: result.providerConversationId || null,
          printPayProviderMessage: result.providerMessage,
          printPayFinalStatusVerified: false,
          printPayFeeBreakdown: result.feeBreakdown,
          printPayInitiatedAt: FieldValue.serverTimestamp(),
          updatedAt: FieldValue.serverTimestamp(),
        });
        tx.set(adminDb.collection('auditLogs').doc(), {
          actorUid: 'SYSTEM_CRON', action: 'SELLER_PAYOUT_PRINTPAY_INITIALIZED',
          entityType: 'SELLER_PAYOUT', entityId: payoutId, amount: claimed.amount,
          feeBreakdown: result.feeBreakdown, createdAt: FieldValue.serverTimestamp(),
        });
        tx.set(adminDb.collection('sellerMarketplaceAudit').doc(), {
          sellerUid: claimed.sellerId, sellerId: claimed.sellerId, actorUid: 'SYSTEM_CRON',
          action: 'SELLER_PAYOUT_PROCESSING', payoutId, amount: claimed.amount,
          currency: 'KES', status: 'PROCESSING', createdAt: FieldValue.serverTimestamp(),
        });
      });
      available -= claimed.amount + FEE_BUFFER;
      dispatched += 1;
    } catch (error) {
      const unknown = Boolean(error?.outcomeUnknown) || /state changed after PrintPay initiation/i.test(String(error?.message || ''));
      const status = unknown ? 'PROVIDER_UNKNOWN' : 'FAILED';
      const safeError = clean(error?.message, 300) || 'PrintPay dispatch failed.';
      try {
        await adminDb.runTransaction(async tx => {
          const fresh = await tx.get(payoutRef);
          if (!fresh.exists || fresh.data()?.status !== 'DISPATCHING') return;
          tx.update(payoutRef, {
            status,
            printPayDispatchError: safeError,
            printPayDispatchOutcomeUnknown: unknown,
            printPayProviderHttpStatus: Number.isInteger(error?.providerHttpStatus) ? error.providerHttpStatus : null,
            printPayProviderRejectionMessage: clean(error?.providerMessage, 300),
            updatedAt: FieldValue.serverTimestamp(),
          });
          tx.set(adminDb.collection('auditLogs').doc(), {
            actorUid: 'SYSTEM_CRON',
            action: unknown ? 'SELLER_PAYOUT_PRINTPAY_OUTCOME_UNKNOWN' : 'SELLER_PAYOUT_PRINTPAY_REJECTED',
            entityType: 'SELLER_PAYOUT', entityId: payoutId, amount: claimed.amount,
            error: safeError, createdAt: FieldValue.serverTimestamp(),
          });
        });
      } catch (persistError) {
        console.error('[cron-marketplace-payouts] CRITICAL: could not persist payout outcome; do not resend.', payoutId, persistError?.message || String(persistError));
      }
      alertAdmin(unknown
        ? `Seller payout outcome unknown for ${claimed.sellerName}, KSh ${claimed.amount}. Reconcile with PrintPay before any retry. Payout: ${payoutId}`
        : `PrintPay rejected seller payout for ${claimed.sellerName}, KSh ${claimed.amount}: ${clean(error?.providerMessage || error?.message, 200)}`);
      skipped += 1;
    }
  }

  return res.status(200).json({ ok: true, walletBalanceAtStart: wallet.balance, scanned, dispatched, skipped });
}

export default processRequestedMarketplacePayouts;
