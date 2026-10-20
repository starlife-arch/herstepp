import { createHash } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { adminDb, requireUser } from '../firebase-admin.js';
import { getMpesaProvider } from '../mpesa-provider.js';
import { clientError, methodNotAllowed } from '../http.js';
import { normalizeSellerPhone } from '../seller-subscription-core.js';

const NAME_CHANGE_FEE = 100;
const clean = value => String(value ?? '').trim();
const toDate = value => value?.toDate?.() || (value instanceof Date ? value : (typeof value === 'string' || typeof value === 'number') ? new Date(value) : null);
const iso = value => { const date = toDate(value); return date && Number.isFinite(date.getTime()) ? date.toISOString() : null; };
const paymentIdFor = (uid, key) => createHash('sha256').update('seller-business-name:' + uid + ':' + key).digest('hex');
const addFiveMonths = date => { const next = new Date(date); next.setMonth(next.getMonth() + 5); return next; };
const normalizePaymentStatus = value => {
  const status = String(value || 'PENDING').toUpperCase();
  if (['PAID', 'SUCCESS', 'SUCCEEDED', 'COMPLETED'].includes(status)) return 'PAID';
  if (['FAILED', 'CANCELLED', 'CANCELED', 'TIMEOUT', 'EXPIRED'].includes(status)) return status === 'CANCELED' ? 'CANCELLED' : status === 'EXPIRED' ? 'TIMEOUT' : status;
  return 'PENDING';
};

function serializeProfile(seller, application, uid) {
  return {
    sellerId: uid,
    displayName: String(seller.displayName || application.displayName || ''),
    businessName: String(seller.businessName || application.businessName || ''),
    phone: String(seller.phone || application.phone || ''),
    defaultPayoutPhone: String(seller.defaultPayoutPhone || ''),
    description: String(seller.description || application.description || ''),
    categories: Array.isArray(seller.categories) ? seller.categories : Array.isArray(application.categories) ? application.categories : [],
    sellerStatus: String(seller.status || application.status || 'NOT_STARTED'),
    billingStatus: String(seller.billingStatus || 'NOT_CONFIGURED'),
    planCode: String(seller.planCode || ''),
    subscriptionExpiresAt: iso(seller.subscriptionExpiresAt),
    businessNameChangedAt: iso(seller.businessNameChangedAt),
    nextBusinessNameChangeAt: (() => { const changedAt = toDate(seller.businessNameChangedAt); return changedAt && Number.isFinite(changedAt.getTime()) ? addFiveMonths(changedAt).toISOString() : null; })(),
  };
}

async function applyNameChangePayment(user, paymentRef, status, providerResult = {}) {
  const result = await adminDb.runTransaction(async tx => {
    const [paymentSnap, sellerSnap, appSnap] = await Promise.all([
      tx.get(paymentRef),
      tx.get(adminDb.collection('sellers').doc(user.uid)),
      tx.get(adminDb.collection('sellerApplications').doc(user.uid)),
    ]);
    if (!paymentSnap.exists) throw clientError('Business name payment not found.', 404);
    const payment = paymentSnap.data() || {};
    if (payment.ownerUid !== user.uid) throw clientError('Forbidden.', 403);
    if (payment.status === 'PAID') return { status: 'PAID', alreadyApplied: true, businessName: String(sellerSnap.data()?.businessName || payment.newBusinessName || '') };
    if (payment.status !== 'PENDING') return { status: payment.status, alreadyApplied: true };
    if (status === 'PAID') {
      if (Number(providerResult.amount ?? payment.amount) !== NAME_CHANGE_FEE) throw clientError('Business name payment amount did not match.', 409);
      if (!sellerSnap.exists || sellerSnap.data()?.status !== 'ACTIVE') throw clientError('An approved seller account is required.', 403);
      const now = new Date();
      const businessName = payment.newBusinessName;
      tx.update(adminDb.collection('sellers').doc(user.uid), {
        businessName, businessNameChangedAt: now, businessNameChangedBy: user.uid,
        updatedAt: FieldValue.serverTimestamp(),
      });
      if (appSnap.exists) tx.update(adminDb.collection('sellerApplications').doc(user.uid), { businessName, updatedAt: now });
      tx.update(paymentRef, {
        status: 'PAID', providerReference: payment.providerReference || providerResult.providerReference || null,
        transactionReference: providerResult.transactionReference || null, completedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(), failureReason: null,
      });
      tx.set(adminDb.collection('sellerMarketplaceAudit').doc(), {
        action: 'SELLER_BUSINESS_NAME_CHANGED', sellerUid: user.uid, actorUid: user.uid,
        oldBusinessName: String(sellerSnap.data()?.businessName || ''),
        newBusinessName: businessName, paymentId: paymentRef.id, amount: NAME_CHANGE_FEE,
        createdAt: FieldValue.serverTimestamp(),
      });
      return { status: 'PAID', alreadyApplied: false, businessName };
    }
    tx.update(paymentRef, {
      status, failureReason: String(providerResult.reason || '').slice(0, 300) || null,
      updatedAt: FieldValue.serverTimestamp(),
    });
    return { status, alreadyApplied: false, businessName: '' };
  });
  // Product documents store a denormalized seller name for card/search display.
  // Refresh those snapshots after the paid name-change transaction commits.
  if (result.status === 'PAID' && result.businessName) {
    try {
      const products = await adminDb.collection('products').where('sellerUid', '==', user.uid).get();
      for (let offset = 0; offset < products.docs.length; offset += 400) {
        const batch = adminDb.batch();
        for (const product of products.docs.slice(offset, offset + 400)) {
          batch.update(product.ref, { sellerBusinessName: result.businessName });
        }
        await batch.commit();
      }
    } catch (error) {
      console.error('[seller-profile] Business name saved but product display sync failed', { sellerUid: user.uid, message: error?.message || String(error) });
    }
  }
  return result;
}

export default async function sellerProfile(req, res) {
  const user = await requireUser(req);
  const sellerRef = adminDb.collection('sellers').doc(user.uid);
  const applicationRef = adminDb.collection('sellerApplications').doc(user.uid);

  if (req.method === 'GET') {
    const paymentId = Array.isArray(req.query.paymentId) ? req.query.paymentId[0] : req.query.paymentId;
    if (typeof paymentId === 'string' && paymentId) {
      if (!/^[a-f0-9]{64}$/.test(paymentId)) throw clientError('Business name payment ID is invalid.');
      const paymentRef = adminDb.collection('sellerBusinessNamePayments').doc(paymentId);
      const snap = await paymentRef.get();
      if (!snap.exists) throw clientError('Business name payment not found.', 404);
      const data = snap.data() || {};
      if (data.ownerUid !== user.uid) throw clientError('Forbidden.', 403);
      if (data.status === 'PENDING' && data.providerReference) {
        try {
          const result = await getMpesaProvider().checkStatus(data.providerReference);
          const normalizedStatus = normalizePaymentStatus(result.status);
          if (normalizedStatus !== 'PENDING') {
            await applyNameChangePayment(user, paymentRef, normalizedStatus, result);
          }
        } catch (error) {
          console.error('seller business name payment reconciliation failed:', error?.message || error);
        }
      }
      const current = (await paymentRef.get()).data() || data;
      return res.json({ payment: {
        paymentId, status: current.status, amount: current.amount, currency: current.currency || 'KES',
        newBusinessName: current.newBusinessName, failureReason: current.failureReason || null,
        transactionReference: current.transactionReference || null,
      } });
    }
    const [sellerSnap, appSnap] = await Promise.all([sellerRef.get(), applicationRef.get()]);
    return res.json({
      profile: serializeProfile(sellerSnap.data() || {}, appSnap.data() || {}, user.uid),
      nameChangeFee: NAME_CHANGE_FEE,
      nameChangeCooldownMonths: 5,
    });
  }

  if (req.method === 'PATCH') {
    const displayName = clean(req.body?.displayName).slice(0, 60);
    const phone = clean(req.body?.phone).slice(0, 24);
    const description = clean(req.body?.description).slice(0, 500);
    const defaultPayoutPhone = clean(req.body?.defaultPayoutPhone) ? normalizeSellerPhone(req.body.defaultPayoutPhone) : '';
    const categories = [...new Set((Array.isArray(req.body?.categories) ? req.body.categories : [])
      .map(clean).filter(value => ['shoes', 'dresses', 'watches', 'necklaces', 'handbags', 'bags', 'accessories', 'other'].includes(value)).slice(0, 8))];
    if (displayName.length < 2) throw clientError('Enter a seller display name (at least 2 characters).');
    if (!/^[+0-9()\\s-]{7,24}$/.test(phone)) throw clientError('Enter a valid contact phone number.');
    if (description.length > 500) throw clientError('Description must be 500 characters or fewer.');
    const [sellerSnap, appSnap] = await Promise.all([sellerRef.get(), applicationRef.get()]);
    if (!sellerSnap.exists && !appSnap.exists) throw clientError('Submit a seller application before editing your profile.', 404);
    const now = FieldValue.serverTimestamp();
    const shared = { displayName, phone, description, categories, defaultPayoutPhone, updatedAt: now };
    if (sellerSnap.exists) await sellerRef.set(shared, { merge: true });
    if (appSnap.exists) await applicationRef.set(shared, { merge: true });
    await adminDb.collection('sellerMarketplaceAudit').add({
      action: 'SELLER_PROFILE_UPDATED', sellerUid: user.uid, actorUid: user.uid,
      changedFields: ['displayName', 'phone', 'description', 'categories', 'defaultPayoutPhone'], createdAt: now,
    });
    return res.json({ success: true, message: 'Business profile updated.', profile: serializeProfile(
      { ...(sellerSnap.data() || {}), ...shared }, { ...(appSnap.data() || {}), ...shared }, user.uid,
    ) });
  }

  if (req.method === 'POST') {
    const action = clean(req.body?.action).toUpperCase();
    if (action !== 'REQUEST_BUSINESS_NAME_CHANGE') throw clientError('Choose a supported profile action.');
    const newBusinessName = clean(req.body?.businessName).slice(0, 100);
    const phone = normalizeSellerPhone(req.body?.phone);
    const key = clean(req.body?.idempotencyKey);
    if (newBusinessName.length < 2) throw clientError('Business name must be at least 2 characters.');
    if (!/^[A-Za-z0-9_-]{12,100}$/.test(key)) throw clientError('A valid idempotency key is required.');
    const sellerSnap = await sellerRef.get();
    if (!sellerSnap.exists || sellerSnap.data()?.ownerUid !== user.uid || sellerSnap.data()?.status !== 'ACTIVE') {
      throw clientError('An approved seller account is required.', 403);
    }
    const seller = sellerSnap.data() || {};
    const lastChange = toDate(seller.businessNameChangedAt);
    if (lastChange && Number.isFinite(lastChange.getTime()) && Date.now() < addFiveMonths(lastChange).getTime()) {
      throw clientError('Business name changes are limited to once every five months. Contact admin if you need an exception.', 409);
    }
    if (newBusinessName === String(seller.businessName || '')) throw clientError('That is already your business name.');
    const paymentId = paymentIdFor(user.uid, key);
    const paymentRef = adminDb.collection('sellerBusinessNamePayments').doc(paymentId);
    const created = await adminDb.runTransaction(async tx => {
      const existing = await tx.get(paymentRef);
      if (existing.exists) {
        const data = existing.data() || {};
        if (data.newBusinessName !== newBusinessName || data.phone !== phone) throw clientError('This payment key was already used for different details.', 409);
        return { existing: true, data };
      }
      const data = {
        paymentId, sellerId: user.uid, ownerUid: user.uid, newBusinessName,
        amount: NAME_CHANGE_FEE, currency: 'KES', phone, method: 'MPESA',
        status: 'PENDING', providerReference: null, transactionReference: null,
        idempotencyKey: key, createdAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(), initiatedAt: FieldValue.serverTimestamp(),
      };
      tx.create(paymentRef, data);
      return { existing: false, data };
    });
    if (created.existing) {
      if (created.data.providerReference) return res.status(202).json({ payment: {
        paymentId, status: created.data.status, amount: created.data.amount, currency: 'KES',
        newBusinessName: created.data.newBusinessName, providerReference: created.data.providerReference,
      }, reused: true });
      throw clientError('This payment is already being prepared. Check status or contact support before retrying.', 409);
    }
    try {
      const stk = await getMpesaProvider().initiateStk({ phone, amount: NAME_CHANGE_FEE });
      await paymentRef.update({ providerReference: stk.providerReference, updatedAt: FieldValue.serverTimestamp() });
      return res.status(202).json({ payment: { paymentId, status: 'PENDING', amount: NAME_CHANGE_FEE, currency: 'KES', newBusinessName, providerReference: stk.providerReference } });
    } catch (error) {
      await paymentRef.update({ initiationError: true, updatedAt: FieldValue.serverTimestamp() }).catch(() => {});
      throw error;
    }
  }

  return methodNotAllowed(res, 'GET, PATCH, POST');
}
