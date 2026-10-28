import { createHash, randomUUID } from 'node:crypto';
import { FieldValue } from 'firebase-admin/firestore';
import { adminDb, requireUser } from '../firebase-admin.js';
import { getMpesaProvider } from '../mpesa-provider.js';
import { clientError, methodNotAllowed } from '../http.js';
import { calculateOutstandingLiability } from '../rewards-liability.js';

const PRICE_PER_CREDIT = 10;
const MIN_CREDITS_PER_PURCHASE = 10;
const MAX_CREDITS_PER_PURCHASE = 10000;
const ALLOWED_SIZES = new Set([...Array.from({ length: 16 }, (_, i) => String(i + 30)), 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'One Size', 'Free Size']);
const DEFAULT_CATEGORIES = ['Block Heels', 'Flats', 'Heels', 'Loafers', 'Platforms', 'Sandals', 'Slides', 'Dresses', 'Clothing', 'Watches', 'Necklaces', 'Bags'];
const TERMINAL = new Set(['PAID', 'FAILED', 'CANCELLED', 'TIMEOUT']);
const dateValue = value => value?.toDate ? value.toDate() : value instanceof Date ? value : (typeof value === 'string' || typeof value === 'number') && !Number.isNaN(new Date(value).getTime()) ? new Date(value) : null;
const paymentIdFor = (uid, key) => createHash('sha256').update('seller-bulk-credits:' + uid + ':' + key).digest('hex');
function publicPayment(id, data) { return { paymentId: id, status: data.status, amount: data.amount, credits: data.credits, providerReference: data.providerReference || null, transactionReference: data.transactionReference || null, failureReason: data.failureReason || null }; }
async function requireActiveSeller(uid) {
  const ref = adminDb.collection('sellers').doc(uid);
  const snap = await ref.get();
  if (!snap.exists || snap.data()?.ownerUid !== uid || snap.data()?.status !== 'ACTIVE') throw clientError('An approved, active seller account is required.', 403);
  const seller = snap.data();
  const expiry = dateValue(seller.subscriptionExpiresAt);
  if (seller.billingStatus !== 'ACTIVE' || !expiry || expiry.getTime() <= Date.now()) throw clientError('An active seller subscription is required to use AI bulk upload.', 403);
  return { ref, seller };
}

export async function applyBulkCreditPayment(db, deps, input) {
  const providerReference = String(input?.providerReference || '');
  const status = String(input?.status || '').toUpperCase();
  if (!providerReference || !['PAID', 'FAILED', 'CANCELLED', 'TIMEOUT', 'PENDING'].includes(status)) throw clientError('Bulk-credit payment result is invalid.');
  const matches = await db.collection('sellerBulkCreditPayments').where('providerReference', '==', providerReference).limit(1).get();
  if (matches.empty) return { applied: false, unknown: true };
  const paymentRef = matches.docs[0].ref;
  return db.runTransaction(async tx => {
    const snap = await tx.get(paymentRef);
    if (!snap.exists) return { applied: false, unknown: true };
    const payment = snap.data();
    if (payment.status === 'PAID' || (TERMINAL.has(payment.status) && status !== 'PAID')) return { applied: false, duplicate: true };
    const expectedCredits = Number(payment.credits);
    const expectedAmount = Number(payment.amount);
    if (!Number.isInteger(expectedCredits) || expectedCredits < MIN_CREDITS_PER_PURCHASE || expectedCredits > MAX_CREDITS_PER_PURCHASE || expectedAmount !== expectedCredits * PRICE_PER_CREDIT) throw clientError('Stored bulk-credit purchase amount is invalid.', 409);
    if (status === 'PAID' && Number(input.amount) !== expectedAmount) throw clientError(`Payment amount does not match KSh ${expectedAmount}.`, 409);
    const patch = { status, transactionReference: input.transactionReference || null, failureReason: status === 'PAID' ? null : (input.reason || status), updatedAt: deps.serverTimestamp(), completedAt: status === 'PENDING' ? null : deps.serverTimestamp(), providerEventId: input.eventId || null };
    if (status === 'PAID') {
      const sellerRef = db.collection('sellers').doc(payment.sellerId);
      const sellerSnap = await tx.get(sellerRef);
      if (!sellerSnap.exists || sellerSnap.data()?.ownerUid !== payment.sellerId) {
        patch.status = 'PAID';
        patch.creditGrantIssue = 'Seller record missing or owner mismatch; support review required.';
      } else {
        tx.update(sellerRef, { bulkUploadCredits: (Number(sellerSnap.data()?.bulkUploadCredits) || 0) + expectedCredits, updatedAt: deps.serverTimestamp() });
        const ledgerRef = db.collection('sellerBulkCreditLedger').doc(paymentRef.id);
        tx.create(ledgerRef, { sellerId: payment.sellerId, paymentId: paymentRef.id, providerReference, type: 'PURCHASE', credits: expectedCredits, amount: expectedAmount, currency: 'KES', createdAt: deps.serverTimestamp() });
        patch.creditsGranted = expectedCredits;
      }
    }
    tx.update(paymentRef, patch);
    return { applied: true, status: patch.status, creditsGranted: patch.creditsGranted || 0 };
  });
}

async function analyzeImage(imageUrl) {
  let parsed;
  try { parsed = new URL(imageUrl); } catch { throw clientError('The uploaded image URL is invalid.'); }
  if (parsed.protocol !== 'https:' || !/^res\.cloudinary\.com$/i.test(parsed.hostname)) throw clientError('Only securely uploaded Cloudinary product images can be analysed.');
  const apiKey = String(process.env.GROQ_API_KEY || '').trim();
  if (!apiKey) throw clientError('AI analysis is not configured. Please contact HerStep support.', 503);
  const model = String(process.env.GROQ_VISION_MODEL || 'qwen/qwen3.8-27b').trim();
  const snapshot = await adminDb.collection('categories').orderBy('name').limit(100).get();
  const categories = [...new Set([...snapshot.docs.map(d => String(d.data().name || '').trim()).filter(Boolean), ...DEFAULT_CATEGORIES])];
  const prompt = `You are preparing product listings for a Kenyan marketplace selling shoes, dresses, clothing, watches, necklaces, handbags and bags. Inspect the product and visible text, not the background. Return JSON only with keys name, description, price, sizes, category, currency, priceConfidence, sizeConfidence. Name: concise and accurate based on visible type, colour and design. Description: 2-4 customer-facing sentences about visible details and suitable occasions. Never invent materials, brand, comfort or durability. Price: whole number printed on the image before any adjustment, otherwise null. The server will add KSh 100 to a clearly printed price; if currency/price is unclear, return null. Sizes: every clearly printed size; paired shoe size 35/36 becomes ["35","36"]; accessories may use ["One Size"] when appropriate. Category must exactly match one of: ${categories.join(', ')}. Never guess unclear text.`;
  let response;
  try {
    response = await fetch('https://api.groq.com/openai/v1/chat/completions', { method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ model, temperature: 0.1, max_tokens: 700, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: imageUrl } }] }] }), signal: AbortSignal.timeout(25000) });
  } catch { throw clientError('The AI service could not be reached. No credit was used; please retry.', 502); }
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error('Seller bulk AI failed:', response.status, payload?.error?.message || 'unknown error');
    throw clientError(response.status === 429 ? 'The AI service is busy or rate-limited. No credit was used; retry later.' : 'AI analysis failed. No credit was used; retry later.', response.status === 429 ? 429 : 502);
  }
  const raw = payload?.choices?.[0]?.message?.content;
  if (typeof raw !== 'string') throw clientError('AI returned no product details. No credit was used.', 502);
  let item;
  try { item = JSON.parse(raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); } catch { throw clientError('AI returned unreadable product details. No credit was used.', 502); }
  const originalPrice = Number.isInteger(item.price) && item.price >= 0 && item.price <= 10000000 ? item.price : null;
  const price = originalPrice === null ? null : originalPrice + 100;
  const rawSizes = Array.isArray(item.sizes) ? item.sizes : item.size == null ? [] : String(item.size).replace(/[,;&+]/g, '/').split('/');
  const sizes = [...new Set(rawSizes.map(v => String(v).trim()).filter(v => ALLOWED_SIZES.has(v)))];
  const categoryName = categories.includes(item.category) ? item.category : DEFAULT_CATEGORIES.includes(item.category) ? item.category : 'Sandals';
  const categoryDoc = snapshot.docs.find(d => String(d.data().name || '').trim() === categoryName);
  const fallbackCategory = snapshot.docs.find(d => String(d.data().name || '').trim().toLowerCase() === 'sandals') || snapshot.docs[0];
  if (!categoryDoc && !fallbackCategory) throw clientError('No product categories are configured. Contact support; no credit was used.', 503);
  const category = categoryDoc || fallbackCategory;
  return {
    name: typeof item.name === 'string' && item.name.trim() ? item.name.trim().slice(0,160) : 'New marketplace product',
    description: typeof item.description === 'string' ? item.description.trim().slice(0,4000) : '',
    price, categoryId: category.id, categoryName: String(category.data().name || categoryName),
    sizes: sizes.length ? sizes : ['One Size'],
    needsReview: price === null || sizes.length === 0 || item.priceConfidence !== 'high' || item.sizeConfidence !== 'high',
  };
}

export default async function sellerBulkUpload(req, res) {
  const user = await requireUser(req);
  const { ref: sellerRef, seller } = await requireActiveSeller(user.uid);
  if (req.method === 'GET') {
    const paymentId = Array.isArray(req.query.paymentId) ? req.query.paymentId[0] : req.query.paymentId;
    if (paymentId) {
      if (typeof paymentId !== 'string' || !/^[a-f0-9]{64}$/.test(paymentId)) throw clientError('Bulk-credit payment id is invalid.');
      const ref = adminDb.collection('sellerBulkCreditPayments').doc(paymentId);
      const snap = await ref.get();
      if (!snap.exists) throw clientError('Bulk-credit payment not found.', 404);
      let data = snap.data();
      if (data.sellerId !== user.uid) throw clientError('Forbidden.', 403);
      if (data.status === 'PENDING' && data.providerReference) {
        try {
          const result = await getMpesaProvider().checkStatus(data.providerReference);
          if (String(result.providerReference) === String(data.providerReference) && result.status !== 'PENDING') await applyBulkCreditPayment(adminDb, { serverTimestamp: () => FieldValue.serverTimestamp() }, { providerReference: data.providerReference, status: result.status, amount: result.amount ?? data.amount, transactionReference: result.transactionReference, eventId: result.eventId || `bulk-status:${paymentId}:${result.status}`, reason: result.reason || null });
        } catch (error) { console.error('Seller bulk-credit status reconciliation failed:', error?.message || error); }
        const refreshed = await ref.get(); if (refreshed.exists) data = refreshed.data();
      }
      const freshSeller = await sellerRef.get();
      return res.json({ payment: publicPayment(paymentId, data), credits: Number(freshSeller.data()?.bulkUploadCredits) || 0 });
    }
    return res.json({ credits: Number(seller.bulkUploadCredits) || 0, pricePerCredit: PRICE_PER_CREDIT, minPurchaseCredits: MIN_CREDITS_PER_PURCHASE, maxPurchaseCredits: MAX_CREDITS_PER_PURCHASE });
  }
  if (req.method !== 'POST') return methodNotAllowed(res, 'GET, POST');
  const action = String(req.body?.action || '');
  if (action === 'redeemRewards') {
    const requestedPoints = Number(req.body?.points);
    const idempotencyKey = String(req.body?.idempotencyKey || '').trim();
    if (!Number.isSafeInteger(requestedPoints) || requestedPoints < 100 || requestedPoints % 100 !== 0) throw clientError('Redeem at least 100 points, in multiples of 100.');
    if (!/^[A-Za-z0-9_-]{8,120}$/.test(idempotencyKey)) throw clientError('A valid redemption request key is required.');
    const redemptionId = createHash('sha256').update('seller-ai-token-reward:' + user.uid + ':' + idempotencyKey).digest('hex');
    const rewardConfigRef = adminDb.collection('rewardsConfig').doc('current');
    const rewardEntryRef = adminDb.collection('rewardLedger').doc(redemptionId);
    const creditLedgerRef = adminDb.collection('sellerBulkCreditLedger').doc(redemptionId);
    const creditsToGrant = requestedPoints / 100; // 100 points = KSh 10 = one AI credit.
    const result = await adminDb.runTransaction(async tx => {
      const [sellerSnap, configSnap, existingSnap, userLedgerSnap, allLedgerSnap] = await Promise.all([
        tx.get(sellerRef), tx.get(rewardConfigRef), tx.get(rewardEntryRef),
        tx.get(adminDb.collection('rewardLedger').where('uid', '==', user.uid)),
        tx.get(adminDb.collection('rewardLedger').where('status', '==', 'POSTED')),
      ]);
      if (existingSnap.exists) return { duplicate: true, credits: Number(sellerSnap.data()?.bulkUploadCredits) || 0 };
      const config = configSnap.data() || {};
      if (config.enabled !== true || config.seller?.enabled === false || config.seller?.redemptionEnabled !== true || !Array.isArray(config.seller?.redemptionTargets) || !config.seller.redemptionTargets.includes('AI_TOKENS')) throw clientError('Seller reward redemption for AI tokens is not enabled by the administrator.');
      const pointValueKes = Math.max(0.001, Number(config.pointValueKes) || 0.1);
      const creditPriceKes = PRICE_PER_CREDIT;
      const valueKes = requestedPoints * pointValueKes;
      if (Math.floor(valueKes / creditPriceKes) !== creditsToGrant) throw clientError('Reward point conversion is not compatible with the current AI credit price.');
      const now = Date.now();
      const balance = userLedgerSnap.docs.reduce((sum, doc) => {
        const entry = doc.data() || {};
        if (String(entry.status || 'POSTED').toUpperCase() !== 'POSTED') return sum;
        const points = Number(entry.points) || 0;
        const expiresAt = dateValue(entry.expiresAt);
        if (points > 0 && expiresAt && expiresAt.getTime() <= now) return sum;
        return sum + points;
      }, 0);
      if (balance < requestedPoints) throw clientError('You do not have enough unexpired reward points.');
      const currentSeller = sellerSnap.data() || {};
      const updatedCredits = (Number(currentSeller.bulkUploadCredits) || 0) + creditsToGrant;
      const timestamp = FieldValue.serverTimestamp();
      tx.create(rewardEntryRef, {
        uid: user.uid, accountType: 'SELLER', type: 'REDEEM', points: -requestedPoints,
        amountKes: valueKes, reason: 'Redeemed reward points for AI bulk-upload credits',
        status: 'POSTED', idempotencyKey: redemptionId, createdAt: timestamp,
        target: 'AI_TOKENS', creditsGranted: creditsToGrant,
      });
      tx.create(creditLedgerRef, {
        sellerId: user.uid, type: 'REWARD_REDEMPTION', credits: creditsToGrant,
        rewardPoints: requestedPoints, amount: valueKes, currency: 'KES',
        redemptionId, createdAt: timestamp,
      });
      tx.update(sellerRef, { bulkUploadCredits: updatedCredits, updatedAt: timestamp });
      const allEntries = allLedgerSnap.docs.map(doc => doc.data() || {});
      allEntries.push({ status: 'POSTED', points: -requestedPoints });
      tx.set(rewardConfigRef, {
        outstandingLiabilityKes: calculateOutstandingLiability(allEntries, pointValueKes),
        liabilityUpdatedAt: timestamp,
      }, { merge: true });
      return { duplicate: false, credits: updatedCredits, creditsGranted: creditsToGrant, pointsRedeemed: requestedPoints };
    });
    return res.status(200).json({ ...result, message: result.duplicate ? 'This reward redemption was already processed.' : `Redeemed ${requestedPoints} points for ${creditsToGrant} AI bulk-upload credit(s).` });
  }
  if (action === 'purchase') {
    const credits = Number(req.body?.credits ?? MIN_CREDITS_PER_PURCHASE);
    if (!Number.isInteger(credits) || credits < MIN_CREDITS_PER_PURCHASE || credits > MAX_CREDITS_PER_PURCHASE) throw clientError(`Choose between ${MIN_CREDITS_PER_PURCHASE} and ${MAX_CREDITS_PER_PURCHASE} credits.`);
    const amount = credits * PRICE_PER_CREDIT;
    const phone = String(req.body?.phone || '').trim();
    const idempotencyKey = String(req.body?.idempotencyKey || '').trim();
    if (!/^[A-Za-z0-9_-]{12,100}$/.test(idempotencyKey)) throw clientError('A valid idempotency key is required.');
    const phoneDigits = phone.replace(/[\s()+-]/g, '');
    if (!/^(?:254[17]\d{8}|0[17]\d{8})$/.test(phoneDigits)) throw clientError('Enter a valid Kenyan M-Pesa phone number.');
    const paymentId = paymentIdFor(user.uid, idempotencyKey);
    const paymentRef = adminDb.collection('sellerBulkCreditPayments').doc(paymentId);
    const created = await adminDb.runTransaction(async tx => {
      const old = await tx.get(paymentRef);
      if (old.exists) {
        const data = old.data();
        if (data.sellerId !== user.uid || data.phone !== phoneDigits) throw clientError('This idempotency key was used for another request.', 409);
        return { existing: true, data };
      }
      const data = { paymentId, sellerId: user.uid, ownerUid: user.uid, amount, credits, currency: 'KES', phone: phoneDigits, method: 'MPESA', status: 'PENDING', providerReference: null, transactionReference: null, failureReason: null, idempotencyKey, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp(), initiatedAt: FieldValue.serverTimestamp() };
      tx.create(paymentRef, data); return { existing: false, data };
    });
    if (created.existing) {
      if (created.data.providerReference) return res.status(202).json({ payment: publicPayment(paymentId, created.data), reused: true });
      throw clientError('This payment request is already being prepared. Check status or contact support before retrying.', 409);
    }
    try {
      const stk = await getMpesaProvider().initiateStk({ phone: phoneDigits, amount });
      await paymentRef.update({ providerReference: stk.providerReference, updatedAt: FieldValue.serverTimestamp() });
      return res.status(202).json({ payment: { paymentId, status: 'PENDING', amount, credits, providerReference: stk.providerReference } });
    } catch (error) { await paymentRef.update({ initiationError: true, updatedAt: FieldValue.serverTimestamp() }).catch(() => {}); throw error; }
  }
  if (action === 'analyze') {
    const imageUrl = String(req.body?.imageUrl || '').trim();
    const publicId = String(req.body?.publicId || '').trim();
    const fileName = String(req.body?.fileName || 'product-image').trim().slice(0, 180);
    if (!imageUrl || imageUrl.length > 2048 || !publicId || publicId.length > 500) throw clientError('Upload one product image first.');
    let image;
    try { image = new URL(imageUrl); } catch { throw clientError('The uploaded image URL is invalid.'); }
    const publicIdBase = publicId.split('/').pop() || '';
    if (!/^res\.cloudinary\.com$/i.test(image.hostname) || !publicIdBase.startsWith(user.uid.slice(0, 10) + '-') || !image.pathname.split('/').pop().startsWith(publicIdBase)) throw clientError('Use an image uploaded through your seller product uploader.', 403);
    const analysed = await analyzeImage(imageUrl);
    const draftId = randomUUID().replace(/-/g, '');
    const sku = `AI-${draftId.slice(0,18).toUpperCase()}`;
    const sizes = analysed.sizes.slice(0, 40);
    const inventory = sizes.map(size => ({ size, quantity: 1, costPrice: null }));
    const productRef = adminDb.collection('sellerProducts').doc(draftId);
    const ledgerRef = adminDb.collection('sellerBulkCreditLedger').doc();
    await adminDb.runTransaction(async tx => {
      const freshSeller = await tx.get(sellerRef);
      if (!freshSeller.exists || freshSeller.data()?.status !== 'ACTIVE' || freshSeller.data()?.ownerUid !== user.uid) throw clientError('Seller account is no longer active.', 403);
      const credits = Number(freshSeller.data()?.bulkUploadCredits) || 0;
      if (credits < 1) throw clientError('No AI bulk-upload credits remain. Purchase a KSh 100 batch of 10 credits to continue.', 402);
      tx.update(sellerRef, { bulkUploadCredits: credits - 1, updatedAt: FieldValue.serverTimestamp() });
      tx.create(productRef, { name: analysed.name, description: analysed.description, categoryId: analysed.categoryId, categoryName: analysed.categoryName, sku, price: analysed.price ?? 0, salePrice: null, inventory, images: [{ url: imageUrl, publicId, resourceType: 'image' }], video: null, status: 'DRAFT', featured: false, bestseller: false, newArrival: false, stockQuantity: inventory.reduce((total, item) => total + item.quantity, 0), availableSizes: inventory.filter(item => item.quantity > 0).map(item => item.size), sellerUid: user.uid, sellerDisplayName: String(seller.displayName || seller.businessName || '').slice(0,60), aiBulkUpload: true, aiNeedsReview: analysed.needsReview, aiOriginalFileName: fileName, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
      tx.create(ledgerRef, { sellerId: user.uid, type: 'CONSUME', credits: -1, productId: draftId, createdAt: FieldValue.serverTimestamp() });
    });
    return res.status(201).json({ product: { id: draftId, name: analysed.name, description: analysed.description, categoryId: analysed.categoryId, categoryName: analysed.categoryName, sku, price: analysed.price, sizes: inventory.map(i => i.size), needsReview: analysed.needsReview, status: 'DRAFT' }, creditsRemaining: Math.max(0, (Number(seller.bulkUploadCredits) || 0) - 1), message: 'AI suggestion saved as a private draft with quantity 1 for each detected size. Review the name, price, category, sizes and stock before publishing.' });
  }
  throw clientError('Choose a valid bulk-upload action.');
}
