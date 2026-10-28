import { createHash } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { adminDb, requireUser, requireAdmin } from '../firebase-admin.js';
import { getMpesaProvider } from '../mpesa-provider.js';
import { clientError, methodNotAllowed } from '../http.js';

const DAY_MS = 7 * 24 * 60 * 60 * 1000;
const money = value => Number.isSafeInteger(value) && value > 0;
const clean = value => String(value ?? '').trim();
const phoneClean = value => clean(value).replace(/[\s()+-]/g, '');
const validPhone = value => /^(?:254[17]\d{8}|0[17]\d{8})$/.test(value);
const serialize = value => {
  if (value?.toDate) return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(serialize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, serialize(v)]));
  return value;
};

// Admin-configurable pricing will be added in the settings UI; these defaults
// are always calculated on the server and never trusted from a browser request.
export function promotionPrice(count) {
  if (!Number.isSafeInteger(count) || count < 1 || count > 500) throw clientError('Choose between 1 and 500 products per promotion campaign.');
  if (count === 1) return 100;
  if (count <= 5) return count * 95;
  if (count <= 10) return count * 90;
  if (count <= 20) return count * 85;
  if (count <= 30) return count * 80;
  if (count <= 50) return count * 75;
  return count * 70;
}
const paymentIdFor = (uid, key) => createHash('sha256').update('herstep-promotion-wallet:' + uid + ':' + key).digest('hex');

async function activeSeller(uid) {
  const snap = await adminDb.collection('sellers').doc(uid).get();
  const seller = snap.data();
  if (!snap.exists || seller?.ownerUid !== uid || seller?.status !== 'ACTIVE') throw clientError('An approved, active seller account is required.', 403);
  const expiry = seller.subscriptionExpiresAt?.toDate?.() || (seller.subscriptionExpiresAt ? new Date(seller.subscriptionExpiresAt) : null);
  if (seller.billingStatus !== 'ACTIVE' || !expiry || !Number.isFinite(expiry.getTime()) || expiry.getTime() <= Date.now()) {
    throw clientError('An active seller subscription is required to promote products.', 403);
  }
  return seller;
}
async function walletSnapshot(uid) {
  const ref = adminDb.collection('sellerPromotionWallets').doc(uid);
  const snap = await ref.get();
  const data = snap.data() || {};
  return { availableBalance: Number(data.availableBalance || 0), totalDeposited: Number(data.totalDeposited || 0), totalSpent: Number(data.totalSpent || 0), updatedAt: serialize(data.updatedAt) };
}
async function applyTopupStatus(paymentId, result) {
  const paymentRef = adminDb.collection('sellerPromotionWalletTopups').doc(paymentId);
  return adminDb.runTransaction(async tx => {
    const snap = await tx.get(paymentRef);
    if (!snap.exists) return { applied: false, unknown: true };
    const payment = snap.data() || {};
    if (payment.status === 'PAID') return { applied: false, duplicate: true };
    if (payment.status !== 'PENDING') return { applied: false, duplicate: true };
    if (String(result.providerReference || '') !== String(payment.providerReference || '')) return { applied: false, mismatch: true };
    if (result.status === 'PENDING') return { applied: false, pending: true };
    if (result.status !== 'PAID') {
      tx.update(paymentRef, { status: result.status, failureReason: result.reason || result.status, updatedAt: FieldValue.serverTimestamp(), completedAt: FieldValue.serverTimestamp() });
      return { applied: true, status: result.status };
    }
    if (Number(result.amount) !== Number(payment.amount)) throw clientError('Payment amount does not match the wallet top-up.', 409);
    const walletRef = adminDb.collection('sellerPromotionWallets').doc(payment.sellerId);
    const walletSnap = await tx.get(walletRef);
    const wallet = walletSnap.data() || {};
    tx.set(walletRef, {
      sellerUid: payment.sellerId,
      availableBalance: Number(wallet.availableBalance || 0) + payment.amount,
      totalDeposited: Number(wallet.totalDeposited || 0) + payment.amount,
      totalSpent: Number(wallet.totalSpent || 0),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });
    const ledgerRef = adminDb.collection('sellerPromotionWalletLedger').doc(paymentId);
    tx.create(ledgerRef, { sellerUid: payment.sellerId, type: 'TOP_UP', amount: payment.amount, balanceDelta: payment.amount, paymentId, providerReference: payment.providerReference, transactionReference: result.transactionReference || null, createdAt: FieldValue.serverTimestamp() });
    tx.update(paymentRef, { status: 'PAID', transactionReference: result.transactionReference || null, failureReason: null, updatedAt: FieldValue.serverTimestamp(), completedAt: FieldValue.serverTimestamp() });
    return { applied: true, status: 'PAID' };
  });
}
async function reconcileTopup(uid, paymentId) {
  if (!/^[a-f0-9]{64}$/.test(paymentId)) throw clientError('Wallet payment id is invalid.');
  const ref = adminDb.collection('sellerPromotionWalletTopups').doc(paymentId);
  const snap = await ref.get();
  if (!snap.exists) throw clientError('Wallet top-up not found.', 404);
  const payment = snap.data() || {};
  if (payment.sellerId !== uid) throw clientError('Forbidden.', 403);
  if (payment.status === 'PENDING' && payment.providerReference) {
    const result = await getMpesaProvider().checkStatus(payment.providerReference);
    if (String(result.providerReference) === String(payment.providerReference) && result.status !== 'PENDING') await applyTopupStatus(paymentId, result);
  }
  const latest = await ref.get();
  return serialize({ id: paymentId, ...(latest.data() || payment) });
}
async function startTopup(uid, body) {
  const amount = Number(body?.amount);
  const phone = phoneClean(body?.phone);
  const key = clean(body?.idempotencyKey);
  if (!money(amount) || amount < 100 || amount > 1000000) throw clientError('Top up at least KSh 100 and no more than KSh 1,000,000.');
  if (!validPhone(phone)) throw clientError('Enter a valid Kenyan M-Pesa phone number.');
  if (!/^[A-Za-z0-9_-]{12,100}$/.test(key)) throw clientError('A valid idempotency key is required.');
  const id = paymentIdFor(uid, key);
  const ref = adminDb.collection('sellerPromotionWalletTopups').doc(id);
  const old = await ref.get();
  if (old.exists) {
    const p = old.data();
    if (p.sellerId !== uid || p.amount !== amount || p.phone !== phone) throw clientError('This payment key was already used for another request.', 409);
    if (p.status === 'PENDING' || p.status === 'PAID') return { payment: serialize({ id, ...p }), reused: true };
    throw clientError('This top-up attempt has ended. Start a new attempt.', 409);
  }
  await ref.create({ sellerId: uid, amount, currency: 'KES', phone, method: 'MPESA', status: 'PENDING', providerReference: null, transactionReference: null, idempotencyKey: key, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  try {
    const stk = await getMpesaProvider().initiateStk({ phone, amount });
    await ref.update({ providerReference: stk.providerReference, updatedAt: FieldValue.serverTimestamp() });
    return { payment: { id, amount, currency: 'KES', status: 'PENDING', providerReference: stk.providerReference } };
  } catch (error) {
    await ref.update({ status: 'FAILED', failureReason: 'The M-Pesa prompt could not be sent. Please try again.', updatedAt: FieldValue.serverTimestamp(), completedAt: FieldValue.serverTimestamp() }).catch(() => {});
    throw error;
  }
}
async function startCampaign(uid, body) {
  const ids = Array.isArray(body?.productIds) ? [...new Set(body.productIds.map(clean).filter(Boolean))] : [];
  if (!ids.length || ids.length > 500 || ids.length !== body.productIds.length) throw clientError('Select between 1 and 500 unique products.');
  const charge = promotionPrice(ids.length);
  const productRefs = ids.map(id => adminDb.collection('products').doc(id));
  const productSnaps = await Promise.all(productRefs.map(ref => ref.get()));
  for (let i = 0; i < productSnaps.length; i++) {
    const p = productSnaps[i].data();
    if (!productSnaps[i].exists || p?.sellerUid !== uid || String(p.status || '').toUpperCase() !== 'ACTIVE') throw clientError('Every selected product must be an active listing owned by your seller account.', 403);
  }
  const campaignRef = adminDb.collection('sellerPromotionCampaigns').doc();
  const ledgerRef = adminDb.collection('sellerPromotionWalletLedger').doc(campaignRef.id);
  const walletRef = adminDb.collection('sellerPromotionWallets').doc(uid);
  const now = Date.now();
  await adminDb.runTransaction(async tx => {
    const [walletSnap, ...freshProducts] = await Promise.all([tx.get(walletRef), ...productRefs.map(ref => tx.get(ref))]);
    const wallet = walletSnap.data() || {};
    if (Number(wallet.availableBalance || 0) < charge) throw clientError('Your promotion wallet does not have enough funds. Top it up first.', 409);
    for (let i = 0; i < freshProducts.length; i++) {
      const p = freshProducts[i].data();
      if (!freshProducts[i].exists || p?.sellerUid !== uid || String(p.status || '').toUpperCase() !== 'ACTIVE') throw clientError('A selected product changed or is no longer eligible. Refresh your products and try again.', 409);
    }
    tx.set(walletRef, { sellerUid: uid, availableBalance: Number(wallet.availableBalance || 0) - charge, totalDeposited: Number(wallet.totalDeposited || 0), totalSpent: Number(wallet.totalSpent || 0) + charge, updatedAt: FieldValue.serverTimestamp() }, { merge: true });
    const promotedUntil = new Date(now + DAY_MS);
    ids.forEach((id, i) => tx.update(productRefs[i], { promotedAt: FieldValue.serverTimestamp(), promotedUntil, promotedCampaignId: campaignRef.id, promotedPaymentId: null, updatedAt: FieldValue.serverTimestamp() }));
    tx.create(campaignRef, { sellerUid: uid, productIds: ids, productCount: ids.length, amount: charge, currency: 'KES', status: 'ACTIVE', durationDays: 7, createdAt: FieldValue.serverTimestamp(), promotedUntil });
    tx.create(ledgerRef, { sellerUid: uid, type: 'CAMPAIGN_SPEND', amount: charge, balanceDelta: -charge, campaignId: campaignRef.id, productIds: ids, productCount: ids.length, createdAt: FieldValue.serverTimestamp() });
  });
  return { campaignId: campaignRef.id, productCount: ids.length, amount: charge, durationDays: 7, promotedUntil: new Date(now + DAY_MS).toISOString(), wallet: await walletSnapshot(uid) };
}
export default async function sellerPromotionWallet(req, res) {
  const user = await requireUser(req);
  await activeSeller(user.uid);
  if (req.method === 'GET') {
    const paymentId = clean(req.query?.paymentId);
    if (paymentId) return res.status(200).json({ payment: await reconcileTopup(user.uid, paymentId) });
    const [wallet, ledgerSnap, campaignSnap, productsSnap] = await Promise.all([
      walletSnapshot(user.uid),
      adminDb.collection('sellerPromotionWalletLedger').where('sellerUid', '==', user.uid).limit(100).get(),
      adminDb.collection('sellerPromotionCampaigns').where('sellerUid', '==', user.uid).limit(100).get(),
      adminDb.collection('products').where('sellerUid', '==', user.uid).limit(500).get(),
    ]);
    const products = productsSnap.docs.filter(d => String(d.data()?.status || '').toUpperCase() === 'ACTIVE').map(d => {
      const p = d.data(); const until = p.promotedUntil?.toDate?.() || (p.promotedUntil ? new Date(p.promotedUntil) : null);
      return { id: d.id, name: String(p.name || 'Product'), promotedUntil: until && until.getTime() > Date.now() ? until.toISOString() : null };
    });
    return res.status(200).json({ wallet, ledger: ledgerSnap.docs.map(d => serialize({ id: d.id, ...d.data() })).sort((a,b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))), campaigns: campaignSnap.docs.map(d => serialize({ id: d.id, ...d.data() })).sort((a,b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))), products, pricing: [1,5,10,20,30,50,100].map(count => ({ count, amount: promotionPrice(count) })) });
  }
  if (req.method !== 'POST') return methodNotAllowed(res, 'GET, POST');
  const action = clean(req.body?.action).toUpperCase();
  if (action === 'REDEEM_REWARDS') {
    const requestedPoints = Number(req.body?.points);
    const key = clean(req.body?.idempotencyKey);
    if (!Number.isSafeInteger(requestedPoints) || requestedPoints < 100 || requestedPoints % 100 !== 0) throw clientError('Redeem at least 100 points, in multiples of 100.');
    if (!/^[A-Za-z0-9_-]{12,100}$/.test(key)) throw clientError('A valid redemption request key is required.');
    const redemptionId = createHash('sha256').update('seller-promotion-wallet-rewards:' + user.uid + ':' + key).digest('hex');
    const rewardConfigRef = adminDb.collection('rewardsConfig').doc('current');
    const rewardRef = adminDb.collection('rewardLedger').doc(redemptionId);
    const walletRef = adminDb.collection('sellerPromotionWallets').doc(user.uid);
    const rewardAccountRef = adminDb.collection('rewardAccounts').doc(user.uid);
    const walletLedgerRef = adminDb.collection('sellerPromotionWalletLedger').doc(redemptionId);
    const result = await adminDb.runTransaction(async tx => {
      const [configSnap, existingReward, existingWalletLedger, userLedger, allLedger, walletSnap, rewardAccountSnap] = await Promise.all([
        tx.get(rewardConfigRef), tx.get(rewardRef), tx.get(walletLedgerRef),
        tx.get(adminDb.collection('rewardLedger').where('uid', '==', user.uid)),
        tx.get(adminDb.collection('rewardLedger').where('status', '==', 'POSTED')), tx.get(walletRef), tx.get(rewardAccountRef),
      ]);
      if (existingReward.exists || existingWalletLedger.exists) return { duplicate: true, wallet: { availableBalance: Number(walletSnap.data()?.availableBalance || 0) } };
      const config = configSnap.data() || {};
      if (config.enabled !== true || config.seller?.enabled === false || config.seller?.redemptionEnabled !== true || !Array.isArray(config.seller?.redemptionTargets) || !config.seller.redemptionTargets.includes('PROMOTIONS')) throw clientError('Seller reward redemption for promotions is not enabled by the administrator.');
      const pointValue = Math.max(0.001, Number(config.pointValueKes) || 0.1);
      const amount = requestedPoints * pointValue;
      if (!Number.isSafeInteger(amount) || amount < 10) throw clientError('Reward points must convert to a whole KSh amount of at least KSh 10.');
      const minPoints = Math.max(1, Math.floor(Number(config.seller?.minRedeemPoints) || 100));
      if (requestedPoints < minPoints) throw clientError(`Redeem at least ${minPoints} points.`);
      const nowMs = Date.now();
      const balance = userLedger.docs.reduce((sum, doc) => {
        const e = doc.data() || {}; if (String(e.status || 'POSTED').toUpperCase() !== 'POSTED') return sum;
        const expires = e.expiresAt?.toMillis?.() ?? e.expiresAt?.toDate?.()?.getTime?.() ?? (e.expiresAt instanceof Date ? e.expiresAt.getTime() : null);
        const p = Number(e.points) || 0; if (p > 0 && expires != null && expires <= nowMs) return sum; return sum + p;
      }, 0);
      if (balance < requestedPoints) throw clientError('You do not have enough unexpired reward points.', 409);
      const wallet = walletSnap.data() || {}; const rewardAccount = rewardAccountSnap.data() || {}; const timestamp = FieldValue.serverTimestamp();
      tx.set(rewardAccountRef, { pointsBalance: Math.max(0, Number(rewardAccount.pointsBalance || 0) - requestedPoints), updatedAt: timestamp }, { merge: true });
      tx.create(rewardRef, { uid: user.uid, accountType: 'SELLER', type: 'REDEEM', points: -requestedPoints, amountKes: amount, reason: 'Redeemed reward points into seller promotion wallet', status: 'POSTED', idempotencyKey: redemptionId, target: 'PROMOTIONS', createdAt: timestamp });
      tx.set(walletRef, { sellerUid: user.uid, availableBalance: Number(wallet.availableBalance || 0) + amount, totalDeposited: Number(wallet.totalDeposited || 0), totalSpent: Number(wallet.totalSpent || 0), updatedAt: timestamp }, { merge: true });
      tx.create(walletLedgerRef, { sellerUid: user.uid, type: 'REWARD_REDEMPTION', amount, balanceDelta: amount, rewardPoints: requestedPoints, redemptionId, createdAt: timestamp });
      const entries = allLedger.docs.map(doc => doc.data() || {}); entries.push({ status: 'POSTED', points: -requestedPoints });
      const liability = entries.reduce((sum, e) => {
        const p = Number(e.points) || 0; const expires = e.expiresAt?.toMillis?.() ?? e.expiresAt?.toDate?.()?.getTime?.() ?? (e.expiresAt instanceof Date ? e.expiresAt.getTime() : null);
        if (p > 0 && expires != null && expires <= nowMs) return sum; return sum + p;
      }, 0) * pointValue;
      tx.set(rewardConfigRef, { outstandingLiabilityKes: Math.max(0, Math.round(liability * 100) / 100), liabilityUpdatedAt: timestamp }, { merge: true });
      return { duplicate: false, pointsRedeemed: requestedPoints, amountAdded: amount, wallet: { availableBalance: Number(wallet.availableBalance || 0) + amount } };
    });
    return res.status(200).json({ ...result, message: result.duplicate ? 'This reward redemption was already processed.' : 'Reward points added to your promotion wallet.' });
  }
  if (action === 'TOP_UP') return res.status(202).json(await startTopup(user.uid, req.body));
  if (action === 'PROMOTE') return res.status(201).json(await startCampaign(user.uid, req.body));
  throw clientError('Choose TOP_UP or PROMOTE.');
}

export async function adminPromotionWallets(req, res) {
  await requireAdmin(req);
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
  const [walletsSnap, topupsSnap, ledgerSnap, campaignsSnap, sellersSnap] = await Promise.all([
    adminDb.collection('sellerPromotionWallets').limit(1000).get(),
    adminDb.collection('sellerPromotionWalletTopups').limit(2000).get(),
    adminDb.collection('sellerPromotionWalletLedger').limit(3000).get(),
    adminDb.collection('sellerPromotionCampaigns').limit(2000).get(),
    adminDb.collection('sellers').limit(1000).get(),
  ]);
  const sellers = new Map(sellersSnap.docs.map(d => [d.id, { id: d.id, ...(d.data() || {}) }]));
  const wallets = walletsSnap.docs.map(d => {
    const w = d.data() || {}; const s = sellers.get(d.id) || {};
    return { sellerUid: d.id, sellerName: s.businessName || s.displayName || s.ownerName || d.id, availableBalance: Number(w.availableBalance || 0), totalDeposited: Number(w.totalDeposited || 0), totalSpent: Number(w.totalSpent || 0), updatedAt: serialize(w.updatedAt) };
  });
  const sum = (items, fn) => items.reduce((total, item) => total + fn(item), 0);
  const topups = topupsSnap.docs.map(d => ({ id: d.id, ...(d.data() || {}) }));
  const ledger = ledgerSnap.docs.map(d => ({ id: d.id, ...(d.data() || {}) }));
  const campaigns = campaignsSnap.docs.map(d => ({ id: d.id, ...(d.data() || {}) }));
  const paidTopups = topups.filter(p => p.status === 'PAID');
  const activeCampaigns = campaigns.filter(c => c.status === 'ACTIVE' && (c.promotedUntil?.toDate?.() || new Date(c.promotedUntil)).getTime() > Date.now());
  const sellerNames = new Map(sellersSnap.docs.map(d => { const s = d.data() || {}; return [d.id, s.businessName || s.displayName || s.ownerName || 'Seller']; }));
  return res.status(200).json({
    summary: {
      totalAvailableBalance: sum(wallets, w => w.availableBalance),
      totalDeposited: sum(paidTopups, p => Number(p.amount || 0)),
      totalAdvertisingSpend: sum(ledger.filter(l => l.type === 'CAMPAIGN_SPEND'), l => Number(l.amount || 0)),
      activeCampaigns: activeCampaigns.length,
      campaigns: campaigns.length,
      sellersWithWallets: wallets.length,
    },
    wallets,
    recentTransactions: ledger.sort((a,b) => String(serialize(b.createdAt) || '').localeCompare(String(serialize(a.createdAt) || ''))).slice(0, 100).map(item => ({ ...serialize(item), sellerName: sellerNames.get(item.sellerUid) || 'Seller' })),
    campaigns: campaigns.slice(0, 200).map(item => ({ ...serialize(item), sellerName: sellerNames.get(item.sellerUid) || 'Seller' })),
  });
}
