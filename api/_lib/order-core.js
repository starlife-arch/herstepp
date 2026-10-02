// Pure order/payment logic shared by the HTTP routes and the offline test suite.
// Every Firestore access goes through the injected `db`, so this module can run
// against a fake in-memory Firestore (`node scripts/test-order-core.mjs`).
//
// CRITICAL RULE: product.inventory is an ARRAY in Firestore. It must always be
// written back as a complete new array — never with dotted paths like
// `inventory.0.quantity`, which Firestore turns into a map and corrupts the doc.
import { clientError } from './http.js';
import { queuePaymentEmail, queueOrderStatusEmail, telegramNewOrder, telegramPayment, telegramLowStock, deliverEmailAfterCommit } from './notify.js';
import { deliveryFee as calculateDeliveryFee } from './delivery.js';
import { normalisePromoCode, calculatePromoDiscount } from './promotion.js';

export const ORDER_STATUS = {
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  PROCESSED: 'PROCESSED',
  OUT_FOR_DELIVERY: 'OUT_FOR_DELIVERY',
  DELIVERED: 'DELIVERED',
  CANCELLED: 'CANCELLED',
};

export const PAYMENT_STATUS = {
  PENDING: 'PENDING',
  PAID: 'PAID',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  TIMEOUT: 'TIMEOUT',
  REFUNDED: 'REFUNDED',
};

export function toIso(value) {
  if (!value) return null;
  if (typeof value === 'object' && typeof value.toDate === 'function') return value.toDate().toISOString();
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return new Date(value).toISOString();
  return null;
}

export function base64url(value) {
  return Buffer.from(String(value), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function receiptNumberFor(paymentId) {
  return `HSP-${String(paymentId || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase()}`;
}

// ---------------------------------------------------------------------------
// Checkout configuration / delivery fee (server-side only; never hardcoded in
// the frontend). Collection is always free; DELIVERY exists only when enabled.
// ---------------------------------------------------------------------------
export async function loadCheckoutSettings(db) {
  const snapshot = await db.doc('settings/checkout').get();
  return snapshot.exists ? snapshot.data() || {} : {};
}


// ---------------------------------------------------------------------------
// Cart validation — every rejection happens BEFORE any Firestore write.
// ---------------------------------------------------------------------------
export function validateCart(cart) {
  if (!Array.isArray(cart) || cart.length === 0) throw clientError('Your cart is empty.');
  if (cart.length > 12) throw clientError('An order can contain at most 12 lines.');
  const seen = new Set();
  const lines = [];
  for (const raw of cart) {
    if (!raw || typeof raw !== 'object') throw clientError('Each cart line must be an object with productId, size and quantity.');
    const { productId, size, quantity } = raw;
    if (typeof productId !== 'string' || !productId.trim()) throw clientError('Each cart line needs a valid productId.');
    if (typeof size !== 'string' || !/^\d{2}$/.test(size.trim())) throw clientError('Size must be a string like "35".');
    const numericSize = Number(size);
    if (!Number.isInteger(numericSize) || numericSize < 30 || numericSize > 45) throw clientError('Size must be between "30" and "45".');
    if (!Number.isInteger(quantity) || quantity < 1 || quantity > 10) throw clientError('Quantity must be a whole number from 1 to 10.');
    const key = `${productId}|${size}`;
    if (seen.has(key)) throw clientError(`Duplicate cart line for product ${productId} size ${size}.`);
    seen.add(key);
    lines.push({ productId: productId.trim(), size: String(numericSize), quantity });
  }
  return lines;
}

// Group lines by productId so several sizes of one product are applied to a
// single working copy (exactly one product update per order).
export function groupByProduct(lines) {
  const groups = new Map();
  for (const line of lines) {
    if (!groups.has(line.productId)) groups.set(line.productId, []);
    groups.get(line.productId).push(line);
  }
  return groups;
}

export function unitPrice(productData) {
  const price = Number(productData.price);
  const sale = Number(productData.salePrice);
  return Number.isFinite(sale) && sale > 0 && sale < price ? sale : price;
}

// Returns a NEW inventory array with the requested decrements applied, or throws.
export function applyDecrement(inventoryArray, size, quantity, productName) {
  const index = inventoryArray.findIndex(i => i.size === size);
  if (index === -1) throw clientError(`${productName} is not available in size ${size}.`);
  const current = Number(inventoryArray[index].quantity) || 0;
  if (current < quantity) {
    throw clientError(`Only ${current} left of ${productName} in size ${size}.`, 409);
  }
  return inventoryArray.map((entry, n) => (n === index ? { size: entry.size, quantity: current - quantity } : { size: entry.size, quantity: Number(entry.quantity) || 0 }));
}

export function deriveStock(inventoryArray) {
  return {
    stockQuantity: inventoryArray.reduce((sum, i) => sum + (Number(i.quantity) || 0), 0),
    availableSizes: inventoryArray.filter(i => (Number(i.quantity) || 0) > 0).map(i => i.size),
  };
}

// Returns a NEW inventory array restoring quantities (order cancelled before payment).
export function restoreInventory(inventoryArray, size, quantity) {
  const index = inventoryArray.findIndex(i => i.size === size);
  if (index === -1) {
    return [...inventoryArray.map(i => ({ size: i.size, quantity: Number(i.quantity) || 0 })), { size, quantity }];
  }
  return inventoryArray.map((entry, n) => (n === index ? { size: entry.size, quantity: (Number(entry.quantity) || 0) + quantity } : { size: entry.size, quantity: Number(entry.quantity) || 0 }));
}

// Guard against documents already corrupted by the old dotted-path writes:
// respond 409 (and log) instead of throwing / writing more damage.
export function requireInventoryArray(productDocId, productData) {
  if (!Array.isArray(productData.inventory)) {
    console.error(`INVENTORY_NOT_ARRAY product=${productDocId}: inventory is ${typeof productData.inventory}, needs repair`);
    throw clientError('Product inventory needs repair', 409);
  }
}

// ---------------------------------------------------------------------------
// POST /api/orders/create — all reads happen before all writes inside ONE
// transaction; order numbers come from orderCounters/{year}.sequence.
// ---------------------------------------------------------------------------
export async function createOrderCore(db, deps, { uid, email, emailVerified, cart, delivery, promoCode }) {
  const { now = () => new Date(), constants } = deps;
  const LOCATION = constants?.LOCATION ?? 'Juja Town, Jerry House, near Juja Posta, Outside Shop No. 12';

  if (email && !emailVerified) throw clientError('Verify your email before creating an order.');
  const lines = validateCart(cart); // rejects bad input BEFORE touching Firestore

  const method = delivery?.deliveryMethod === 'COLLECTION' ? 'COLLECTION' : 'DELIVERY';
  const fullName = typeof delivery?.fullName === 'string' ? delivery.fullName.trim() : '';
  // normalizePhone throws a clear human message for anything that is not a
  // valid Kenyan number — every validation failure must be readable.
  const phone = deps.normalizePhone(delivery?.phone);
  // The email is NEVER required from the client: it comes from the verified
  // auth token (u.email) or the users/{uid} doc (read inside the transaction).
  const submittedEmail = typeof delivery?.email === 'string' ? delivery.email.trim().toLowerCase() : '';
  if (!fullName) throw clientError('Full name is required.');
  const location = method === 'COLLECTION' ? LOCATION : (typeof delivery?.location === 'string' ? delivery.location.trim() : '');
  if (method === 'DELIVERY' && !location) throw clientError('A delivery location is required.');
  // Contract field is `instructions`; accept `notes` as a fallback.
  const instructions = [delivery?.instructions, delivery?.notes]
    .find(v => typeof v === 'string' && v.trim())
    ?.trim()
    .slice(0, 500) ?? '';

  const settings = await loadCheckoutSettings(db);
  if (method === 'COLLECTION' && settings.collectionEnabled === false) throw clientError('Collection is currently unavailable. Please choose delivery.');
  if (method === 'DELIVERY' && settings.deliveryEnabled !== true) throw clientError('Delivery is currently unavailable. Please choose collection.');

  const year = now().getUTCFullYear();
  const groups = groupByProduct(lines);
  const requestedPromo = promoCode == null || promoCode === '' ? null : normalisePromoCode(promoCode);

  return db.runTransaction(async tx => {
    // ---- ALL READS FIRST -------------------------------------------------
    const userSnap = await tx.get(db.collection('users').doc(uid));
    const userData = userSnap.exists ? userSnap.data() || {} : {};

    const counterRef = db.collection('orderCounters').doc(String(year));
    const counterSnap = await tx.get(counterRef);
    const sequence = (Number(counterSnap.exists ? counterSnap.data()?.sequence : 0) || 0) + 1;
    const orderId = `HS-${year}-${String(sequence).padStart(6, '0')}`;

    const productRefs = [...groups.keys()].map(id => db.collection('products').doc(id));
    const productSnaps = await tx.getAll(...productRefs);
    const productsById = new Map();
    productSnaps.forEach((snap, i) => productsById.set(productRefs[i].id, snap));

    const plan = [];
    let subtotal = 0;
    const items = [];
    for (const [productId, productLines] of groups) {
      const snap = productsById.get(productId);
      if (!snap || !snap.exists) throw clientError('One of the products in your cart no longer exists.', 404);
      const data = snap.data();
      if (data.status !== 'ACTIVE') throw clientError(`${data.name || productId} is unavailable right now.`, 409);
      requireInventoryArray(productId, data);

      let inventory = data.inventory.map(i => ({ size: i.size, quantity: Number(i.quantity) || 0 }));
      const changes = [];
      for (const line of productLines) {
        const before = inventory.find(i => i.size === line.size)?.quantity ?? 0;
        inventory = applyDecrement(inventory, line.size, line.quantity, data.name || productId);
        const after = inventory.find(i => i.size === line.size)?.quantity ?? 0;
        changes.push({ size: line.size, quantity: line.quantity, previousQuantity: before, newQuantity: after });
        const price = unitPrice(data);
        subtotal += price * line.quantity;
        items.push({
          productId,
          name: data.name,
          sku: data.sku,
          categoryId: data.categoryId ?? null,
          size: line.size,
          quantity: line.quantity,
          unitPrice: price,
          lineTotal: price * line.quantity,
          imageUrl: Array.isArray(data.images) ? data.images[0]?.url ?? null : null,
        });
      }
      plan.push({ ref: snap.ref, data, inventory, changes });
    }

    const deliveryFee = method === 'COLLECTION' ? 0 : calculateDeliveryFee(settings, location);
    let discount = 0; let promotion = null; let promoRef = null; let promoUsageRef = null; let promo = null; let promoUsage = 0;
    if (requestedPromo) {
      promoRef = db.collection('promoCodes').doc(requestedPromo); const promoSnap = await tx.get(promoRef);
      if (!promoSnap.exists) throw clientError('This promo code is invalid.', 404); promo = promoSnap.data();
      promoUsageRef = db.collection('promoCodeUsages').doc(`${requestedPromo}_${uid}`); const usageSnap = await tx.get(promoUsageRef); promoUsage = Number(usageSnap.exists ? usageSnap.data()?.usageCount : 0);
      if (Number(promo.usageCount || 0) >= Number(promo.maximumUsage ?? Infinity)) throw clientError('This promo code has reached its usage limit.', 409);
      if (promoUsage >= Number(promo.perCustomerUsage ?? 1)) throw clientError('You have already used this promo code.', 409);
      const calculated = calculatePromoDiscount(promo, items, subtotal, now()); discount = Math.min(calculated.discount, Math.max(0, subtotal + deliveryFee - 1));
      promotion = { code: requestedPromo, name: promo.name, discountType: promo.discountType, discountValue: promo.discountValue };
    }
    const total = subtotal + deliveryFee - discount;
    if (!Number.isInteger(total) || total < 1) throw clientError('We could not calculate the order total.');

    // ---- ALL WRITES SECOND -----------------------------------------------
    if (promoRef && promoUsageRef && promo) {
      tx.update(promoRef, { usageCount: Number(promo.usageCount || 0) + 1, updatedAt: deps.serverTimestamp() });
      tx.set(promoUsageRef, { code: requestedPromo, customerId: uid, usageCount: promoUsage + 1, updatedAt: deps.serverTimestamp() }, { merge: true });
    }
    tx.set(counterRef, { sequence, year }, { merge: true });

    const orderRef = db.collection('orders').doc();
    tx.set(orderRef, {
      orderId,
      customerId: uid,
      // NEVER fall back to the uid — admins and customers must always see a
      // human name. OrderTracking self-heals legacy docs with an empty name.
      customerName: fullName || userData.displayName || '',
      customerPhone: phone,
      // Email never comes from the client payload: verified token first, then
      // the users/{uid} doc. (delivery.email is NOT required any more.)
      customerEmail: email || userData.email || submittedEmail || '',
      items,
      subtotal,
      deliveryFee,
      discount,
      promoCode: requestedPromo,
      promotion,
      total,
      currency: 'KES',
      // Exactly the AGENTS.md contract shape — payments/stk/initiate reads
      // order.delivery.phone from here.
      delivery: {
        fullName,
        phone,
        deliveryMethod: method,
        location: method === 'COLLECTION' ? LOCATION : location,
        instructions,
      },
      paymentStatus: PAYMENT_STATUS.PENDING,
      paymentId: null,
      paymentReference: null,
      activePaymentId: null,
      orderStatus: ORDER_STATUS.PENDING,
      inventoryReserved: true,
      source: 'WEB',
      createdAt: deps.serverTimestamp(),
      updatedAt: deps.serverTimestamp(),
    });

    for (const p of plan) {
      const derived = deriveStock(p.inventory);
      tx.update(p.ref, {
        inventory: p.inventory, // full ARRAY — never dotted paths
        stockQuantity: derived.stockQuantity,
        availableSizes: derived.availableSizes,
        updatedAt: deps.serverTimestamp(),
      });
      for (const c of p.changes) {
        tx.set(db.collection('inventoryLogs').doc(), {
          productId: p.ref.id,
          productName: p.data.name ?? null,
          size: c.size,
          previousQuantity: c.previousQuantity,
          newQuantity: c.newQuantity,
          reason: 'ORDER_RESERVED',
          orderId,
          orderDocumentId: orderRef.id,
          actorType: 'SYSTEM',
          actorId: uid,
          createdAt: deps.serverTimestamp(),
        });
      }
    }

    tx.set(db.collection('orderStatusHistory').doc(), {
      orderId,
      orderDocumentId: orderRef.id,
      customerId: uid,
      eventType: 'ORDER_STATUS_CHANGED',
      previousStatus: null,
      newStatus: ORDER_STATUS.PENDING,
      paymentStatus: PAYMENT_STATUS.PENDING,
      note: 'Order placed; awaiting payment.',
      source: 'SYSTEM',
      createdAt: deps.serverTimestamp(),
    });

    tx.set(db.collection('notifications').doc(`${orderRef.id}-ORDER_PLACED`), {
      customerId: uid,
      orderDocumentId: orderRef.id,
      event: 'ORDER_PLACED',
      title: 'Order placed',
      body: `We received your order ${orderId}. Complete M-Pesa payment to confirm it.`,
      readAt: null,
      createdAt: deps.serverTimestamp(),
    });

    // Best-effort Telegram ping for the admins (NEVER blocks or fails the
    // order — sendTelegramMessage cannot throw and this promise is not awaited).
    telegramNewOrder({ orderId, total, customerName: fullName, items });

    // Low-stock alerts: any size left at <= 2 after this reservation. Once per
    // product+size+quantity value (marker docs) — also fully best-effort.
    const lowStockChanges = [];
    for (const p of plan) {
      for (const c of p.changes) {
        lowStockChanges.push({ productId: p.ref.id, productName: p.data.name ?? null, ...c });
      }
    }
    Promise.resolve(telegramLowStock(db, lowStockChanges)).catch(() => {});

    return {
      order: {
        id: orderRef.id,
        orderId,
        subtotal,
        deliveryFee,
        discount,
        total,
        currency: 'KES',
        orderStatus: ORDER_STATUS.PENDING,
        paymentStatus: PAYMENT_STATUS.PENDING,
      },
    };
  });
}

// ---------------------------------------------------------------------------
// Payment projection returned by the payments endpoints.
// ---------------------------------------------------------------------------
export function publicPayment(docId, data) {
  return {
    id: docId,
    orderDocumentId: data.orderDocumentId ?? null,
    orderId: data.orderId ?? null,
    amount: Number(data.amount) || 0,
    currency: data.currency || 'KES',
    method: data.method || 'MPESA_STK',
    status: data.status ?? null,
    providerReference: data.providerReference ?? null,
    transactionReference: data.transactionReference ?? null,
    receiptNumber: data.receiptNumber ?? null,
    failureReason: data.failureReason ?? null,
    createdAt: toIso(data.createdAt),
    completedAt: toIso(data.completedAt),
  };
}

// ---------------------------------------------------------------------------
// Verified payment callback (webhook OR status poll) applied in ONE
// transaction: idempotent via paymentTransactions/{base64url(eventId)},
// exact amount match, allowed transitions only, deterministic history +
// notification ids. On FAILED/CANCELLED/TIMEOUT the reserved stock is restored
// with a NEW inventory array (+ inventoryLogs) and activePaymentId is cleared
// so the customer can retry.
// ---------------------------------------------------------------------------
export const ALLOWED_PAYMENT_TRANSITIONS = {
  [PAYMENT_STATUS.PENDING]: [PAYMENT_STATUS.PAID, PAYMENT_STATUS.FAILED, PAYMENT_STATUS.CANCELLED, PAYMENT_STATUS.TIMEOUT],
  [PAYMENT_STATUS.PAID]: [PAYMENT_STATUS.REFUNDED],
};

export async function applyVerifiedCallbackCore(db, deps, callback) {
  const { providerReference, status, amount, transactionReference = null, eventId, source = 'PRINTPAY' } = callback || {};
  if (!providerReference) throw clientError('Missing provider reference.', 400);
  if (!Object.values(PAYMENT_STATUS).includes(status)) throw clientError('Unknown payment status.', 400);
  if (!eventId) throw clientError('Missing event id.', 400);

  const idempotencyId = base64url(eventId);
  const idemRef = db.collection('paymentTransactions').doc(idempotencyId);

  return db.runTransaction(async tx => {
    // ---- READS FIRST ----
    const prior = await tx.get(idemRef);
    if (prior.exists) {
      return { duplicate: true, status: prior.data()?.appliedStatus ?? status };
    }

    const paymentsSnap = await tx.get(
      db.collection('payments').where('providerReference', '==', providerReference).limit(1)
    );
    if (paymentsSnap.empty) throw clientError('Payment not found.', 404);
    const paymentRef = paymentsSnap.docs[0].ref;
    const paymentSnap = await tx.get(paymentRef);
    const payment = paymentSnap.data();

    // Idempotency safety net: a terminal payment never changes again — EXCEPT the
    // LATE SUCCESS case: if a verified PAID arrives for a payment we already gave
    // up on (TIMEOUT/FAILED/CANCELLED), the customer really paid. Do NOT reject
    // it with 409; allow the transition to PAID below.
    const TERMINAL_STATUSES = ['PAID', 'FAILED', 'CANCELLED', 'TIMEOUT', 'REFUNDED'];
    const LATE_SUCCESS = TERMINAL_STATUSES.includes(payment.status) && status === PAYMENT_STATUS.PAID
      && ['TIMEOUT', 'FAILED', 'CANCELLED'].includes(payment.status);
    if (TERMINAL_STATUSES.includes(payment.status) && !LATE_SUCCESS) {
      return { duplicate: true, status: payment.status };
    }

    const orderRef = db.collection('orders').doc(payment.orderDocumentId);
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists) throw clientError('Order not found.', 404);
    const order = orderSnap.data();

    // The order referenced by the callback must be the payment's own order.
    if (callback.orderId && order.orderId !== callback.orderId) {
      throw clientError('Payment does not belong to this order.', 409);
    }

    // The callback amount must EQUAL the payment amount exactly.
    const paidAmount = Number(amount);
    if (!Number.isFinite(paidAmount) || paidAmount !== Number(payment.amount)) {
      throw clientError('The callback amount does not match the payment amount.', 409);
    }

    const from = payment.status;
    if (from === status) {
      // Same state recorded under a different event id: nothing to do.
      tx.set(idemRef, {
        paymentId: paymentRef.id,
        orderDocumentId: payment.orderDocumentId,
        providerReference,
        eventType: 'STATUS_NO_CHANGE',
        appliedStatus: status,
        amount: paidAmount,
        source,
        createdAt: deps.serverTimestamp(),
      });
      return { duplicate: true, status };
    }
    if (!LATE_SUCCESS && !(ALLOWED_PAYMENT_TRANSITIONS[from] || []).includes(status)) {
      throw clientError(`Payment transition ${from} -> ${status} is not allowed.`, 409);
    }

    // ---- WRITES ----
    tx.set(idemRef, {
      paymentId: paymentRef.id,
      orderDocumentId: payment.orderDocumentId,
      providerReference,
      eventType: `PAYMENT_${status}`,
      appliedStatus: status,
      amount: paidAmount,
      transactionReference,
      source,
      createdAt: deps.serverTimestamp(),
    });

    tx.update(paymentRef, {
      status,
      transactionReference: transactionReference || payment.transactionReference || null,
      failureReason: status === PAYMENT_STATUS.PAID ? null : (callback.reason || `M-Pesa ${status.toLowerCase()}`),
      completedAt: deps.serverTimestamp(),
      receiptNumber: status === PAYMENT_STATUS.PAID ? receiptNumberFor(paymentRef.id) : payment.receiptNumber ?? null,
      updatedAt: deps.serverTimestamp(),
    });

    const orderUpdate = { updatedAt: deps.serverTimestamp() };
    if (status === PAYMENT_STATUS.PAID) {
      orderUpdate.paymentStatus = PAYMENT_STATUS.PAID;
      orderUpdate.paymentId = paymentRef.id;
      orderUpdate.paymentReference = transactionReference || providerReference;
      // Denormalise the receipt onto the order so /api/orders/track and the
      // dashboard can show it without a second payments query.
      orderUpdate.receiptNumber = receiptNumberFor(paymentRef.id);
      if (LATE_SUCCESS) {
        // The order may have been auto-cancelled while we waited for this money.
        orderUpdate.orderStatus = order.orderStatus === 'CANCELLED' ? 'PENDING' : order.orderStatus;
        orderUpdate.needsReviewNote = 'Payment succeeded after the attempt had already timed out or failed; stock reservation must be re-checked.';
      }
    } else {
      orderUpdate.paymentStatus = status;
      // Customer may retry: drop the pointer to the dead payment attempt.
      orderUpdate.activePaymentId = null;
    }
    tx.update(orderRef, orderUpdate);

    const previousPaymentStatus = payment.status;
    tx.set(db.collection('orderStatusHistory').doc(`${payment.orderDocumentId}-PAYMENT_${status}_${idempotencyId}`), {
      orderId: order.orderId,
      orderDocumentId: payment.orderDocumentId,
      customerId: order.customerId,
      eventType: 'PAYMENT_STATUS_CHANGED',
      previousStatus: previousPaymentStatus,
      newStatus: status,
      paymentStatus: status,
      note: status === PAYMENT_STATUS.PAID
        ? `M-Pesa payment confirmed (${transactionReference || providerReference}).`
        : `Payment ${status.toLowerCase()}.`,
      source,
      createdAt: deps.serverTimestamp(),
    });

    tx.set(db.collection('notifications').doc(`${payment.orderDocumentId}-PAYMENT_${status}`), {
      customerId: order.customerId,
      orderDocumentId: payment.orderDocumentId,
      event: 'PAYMENT_STATUS_CHANGED',
      title: status === PAYMENT_STATUS.PAID ? 'Payment received' : 'Payment update',
      body: status === PAYMENT_STATUS.PAID
        ? `We received your payment for order ${order.orderId}. Thank you!`
        : `Your payment for order ${order.orderId} was ${status.toLowerCase()}. You can try again.`,
      readAt: null,
      createdAt: deps.serverTimestamp(),
    });

    // Receipt / failure email queued INSIDE this transaction with a
    // deterministic key (<orderDoc>-PAYMENT-<STATUS>) — a replayed webhook or
    // poll can never double-send. Delivery happens after commit (waitUntil).
    queuePaymentEmail(tx, db, {
      orderDocumentId: payment.orderDocumentId,
      order,
      status,
      failureReason: status === PAYMENT_STATUS.PAID ? null : (callback.reason || `M-Pesa ${status.toLowerCase()}`),
      receiptNumber: status === PAYMENT_STATUS.PAID ? receiptNumberFor(paymentRef.id) : null,
    });
    const queuedEmailKeys = [`${payment.orderDocumentId}-PAYMENT-${status}`];

    // Unpaid orders that go away release their reserved stock — in the SAME
    // transaction, writing a NEW inventory array (never dotted paths).
    let restored = [];
    if (status !== PAYMENT_STATUS.PAID && order.inventoryReserved === true) {
      const byProduct = groupByProduct((order.items || []).map(i => ({ productId: i.productId, size: i.size, quantity: i.quantity })));
      const refs = [...byProduct.keys()].map(id => db.collection('products').doc(id));
      const snaps = refs.length ? await tx.getAll(...refs) : [];
      for (let n = 0; n < snaps.length; n += 1) {
        const snap = snaps[n];
        if (!snap.exists) continue;
        const data = snap.data();
        if (!Array.isArray(data.inventory)) {
          console.error(`INVENTORY_NOT_ARRAY product=${refs[n].id} during cancel-restore: needs repair`);
          continue;
        }
        let inventory = data.inventory.map(i => ({ size: i.size, quantity: Number(i.quantity) || 0 }));
        for (const line of byProduct.get(refs[n].id)) {
          const before = inventory.find(i => i.size === line.size)?.quantity ?? 0;
          inventory = restoreInventory(inventory, line.size, line.quantity);
          const after = inventory.find(i => i.size === line.size)?.quantity ?? 0;
          tx.set(db.collection('inventoryLogs').doc(), {
            productId: refs[n].id,
            productName: data.name ?? null,
            size: line.size,
            previousQuantity: before,
            newQuantity: after,
            reason: 'PAYMENT_CANCELLED_RESTORE',
            orderId: order.orderId,
            orderDocumentId: payment.orderDocumentId,
            actorType: 'SYSTEM',
            actorId: 'printpay-callback',
            createdAt: deps.serverTimestamp(),
          });
          restored.push({ productId: refs[n].id, size: line.size, quantity: line.quantity });
        }
        const derived = deriveStock(inventory);
        tx.update(snap.ref, {
          inventory, // full ARRAY
          stockQuantity: derived.stockQuantity,
          availableSizes: derived.availableSizes,
          updatedAt: deps.serverTimestamp(),
        });
      }
      tx.update(orderRef, { inventoryReserved: false });
    }

    // LATE SUCCESS SAFETY: the money landed after we had already given up and
    // restored the reserved stock. Try to reserve it AGAIN with a complete new
    // inventory array. If any size no longer has enough stock we do NOT reject
    // or lose the payment: mark PAID anyway (the customer really paid) and set
    // order.needsReview = true so admin sees the conflict immediately.
    if (status === PAYMENT_STATUS.PAID && LATE_SUCCESS && order.inventoryReserved !== true) {
      let shortStock = false;
      const byProduct = groupByProduct((order.items || []).map(i => ({ productId: i.productId, size: i.size, quantity: i.quantity })));
      const refs = [...byProduct.keys()].map(id => db.collection('products').doc(id));
      const snaps = refs.length ? await tx.getAll(...refs) : [];
      for (let n = 0; n < snaps.length; n += 1) {
        const snap = snaps[n];
        if (!snap.exists) { shortStock = true; continue; }
        const data = snap.data();
        if (!Array.isArray(data.inventory)) {
          console.error(`INVENTORY_NOT_ARRAY product=${refs[n].id} during late-success re-reserve: needs repair`);
          shortStock = true;
          continue;
        }
        let inventory = data.inventory.map(i => ({ size: i.size, quantity: Number(i.quantity) || 0 }));
        for (const line of byProduct.get(refs[n].id)) {
          const before = inventory.find(i => i.size === line.size)?.quantity ?? 0;
          if (before < line.quantity) {
            shortStock = true;
            continue;
          }
          inventory = applyDecrement(inventory, line.size, line.quantity, data.name); // returns the NEW ARRAY itself
          const after = inventory.find(i => i.size === line.size)?.quantity ?? 0;
          tx.set(db.collection('inventoryLogs').doc(), {
            productId: refs[n].id,
            productName: data.name ?? null,
            size: line.size,
            previousQuantity: before,
            newQuantity: after,
            reason: 'LATE_PAYMENT_RERESEVE',
            orderId: order.orderId,
            orderDocumentId: payment.orderDocumentId,
            actorType: 'SYSTEM',
            actorId: 'printpay-callback',
            createdAt: deps.serverTimestamp(),
          });
        }
        const derived = deriveStock(inventory);
        tx.update(snap.ref, {
          inventory, // full ARRAY — never dotted paths
          stockQuantity: derived.stockQuantity,
          availableSizes: derived.availableSizes,
          updatedAt: deps.serverTimestamp(),
        });
      }
      tx.update(orderRef, {
        inventoryReserved: !shortStock,
        ...(shortStock ? { needsReview: true } : {}),
      });
    }

    return { duplicate: false, status, paymentId: paymentRef.id, orderDocumentId: payment.orderDocumentId, restored, lateSuccess: LATE_SUCCESS, emailKeys: queuedEmailKeys };
  }).then(result => ({ ...result, emailFlush: flushPaymentEmails(db, result) }));
}

// POST-COMMIT EMAIL FLUSH for payment events. Returns a promise that routes
// hand to waitUntil(); it is ALREADY started here so nothing is lost even if a
// caller forgets to await/flush, and it can never throw into the response path.
function flushPaymentEmails(db, result) {
  if (!result || result.duplicate) return Promise.resolve();
  return (async () => {
    const orderSnapForNotify = await db.collection('orders').doc(result.orderDocumentId || '').get().catch(() => null);
    const orderData = orderSnapForNotify?.exists ? orderSnapForNotify.data() : null;
    telegramPayment(result.status, orderData || {}, { amount: undefined, failureReason: undefined });
    for (const key of result.emailKeys || []) await deliverEmailAfterCommit(db, key);
  })().catch(error => {
    console.error('[order-core] post-commit payment notify failed:', error?.message || error);
  });
}


async function releasePromoUsage(tx, db, order, deps) {
  if (!order.promoCode || order.promoReleased === true) return;
  const promoRef = db.collection('promoCodes').doc(order.promoCode);
  const usageRef = db.collection('promoCodeUsages').doc(`${order.promoCode}_${order.customerId}`);
  const [promoSnap, usageSnap] = await Promise.all([tx.get(promoRef), tx.get(usageRef)]);
  if (promoSnap.exists) tx.update(promoRef, { usageCount: Math.max(0, Number(promoSnap.data().usageCount || 0) - 1), updatedAt: deps.serverTimestamp() });
  if (usageSnap.exists) tx.update(usageRef, { usageCount: Math.max(0, Number(usageSnap.data().usageCount || 0) - 1), updatedAt: deps.serverTimestamp() });
}
// ---------------------------------------------------------------------------
// Admin PATCH /api/admin/orders — status transitions. Cancelling an UNPAID
// order restores reserved stock in the same transaction (new inventory arrays
// plus inventoryLogs).
// ---------------------------------------------------------------------------
// Single source of truth for order status transitions. Exported so the admin
// frontend can render ONLY the allowed next statuses per order.
export const ORDER_STATUSES = ['PENDING', 'PROCESSING', 'PROCESSED', 'OUT_FOR_DELIVERY', 'DELIVERED', 'CANCELLED'];

export const ALLOWED_ORDER_TRANSITIONS = {
  PENDING: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['PROCESSED', 'CANCELLED'],
  PROCESSED: ['OUT_FOR_DELIVERY', 'CANCELLED'],
  OUT_FOR_DELIVERY: ['DELIVERED', 'CANCELLED'],
  DELIVERED: [],
  CANCELLED: [],
};

const VALID_ORDER_STATUSES = new Set(ORDER_STATUSES);

export function nextOrderStatuses(current) {
  return ALLOWED_ORDER_TRANSITIONS[current] || [];
}

function humanStatus(s) {
  return String(s || '')
    .split('_')
    .map(w => (w ? w[0] + w.slice(1).toLowerCase() : w))
    .join(' ');
}

export async function adminOrderTransitionCore(db, deps, { actorUid, orderDocumentId, orderStatus, note }) {
  if (typeof orderDocumentId !== 'string' || !orderDocumentId) throw clientError('orderDocumentId is required.');
  if (typeof orderStatus !== 'string' || !VALID_ORDER_STATUSES.has(orderStatus)) {
    throw clientError('A valid orderStatus is required.');
  }

  return db.runTransaction(async tx => {
    const orderRef = db.collection('orders').doc(orderDocumentId);
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists) throw clientError('Order not found.', 404);
    const order = orderSnap.data();

    const allowed = ALLOWED_ORDER_TRANSITIONS[order.orderStatus] || [];
    if (!allowed.includes(orderStatus)) {
      throw clientError(
        `Cannot move an order from ${humanStatus(order.orderStatus)} to ${humanStatus(orderStatus)}.`,
        409,
      );
    }
    if (orderStatus === 'PROCESSING' && order.paymentStatus !== 'PAID') throw clientError('Payment must be confirmed before processing.', 409);

    // Reads needed for a possible stock restore must happen before writes.
    let restorePlan = [];
    const activePaymentReads = [];
    if (orderStatus === 'CANCELLED') {
      // Admin must never see "Cancelled order + Pending payment": read the
      // order's active PENDING payment so it can be terminalised in THIS tx.
      if (typeof order.activePaymentId === 'string' && order.activePaymentId) {
        const pSnap = await tx.get(db.collection('payments').doc(order.activePaymentId));
        if (pSnap.exists && pSnap.data().status === 'PENDING') activePaymentReads.push({ ref: pSnap.ref, data: pSnap.data() });
      }
    }
    if (orderStatus === 'CANCELLED' && order.inventoryReserved === true) {
      const byProduct = groupByProduct((order.items || []).map(i => ({ productId: i.productId, size: i.size, quantity: i.quantity })));
      const refs = [...byProduct.keys()].map(id => db.collection('products').doc(id));
      const snaps = refs.length ? await tx.getAll(...refs) : [];
      for (let n = 0; n < snaps.length; n += 1) {
        const snap = snaps[n];
        if (!snap.exists) continue;
        const data = snap.data();
        if (!Array.isArray(data.inventory)) {
          console.error(`INVENTORY_NOT_ARRAY product=${refs[n].id} during admin cancel: needs repair`);
          continue;
        }
        let inventory = data.inventory.map(i => ({ size: i.size, quantity: Number(i.quantity) || 0 }));
        const changes = [];
        for (const line of byProduct.get(refs[n].id)) {
          const before = inventory.find(i => i.size === line.size)?.quantity ?? 0;
          inventory = restoreInventory(inventory, line.size, line.quantity);
          const after = inventory.find(i => i.size === line.size)?.quantity ?? 0;
          changes.push({ ...line, previousQuantity: before, newQuantity: after });
        }
        restorePlan.push({ ref: snap.ref, data, inventory, changes });
      }
    }

    if (orderStatus === 'CANCELLED') await releasePromoUsage(tx, db, order, deps);
    tx.update(orderRef, {
      orderStatus,
      ...(orderStatus === 'CANCELLED'
        ? {
            promoReleased: order.promoReleased === true ? true : true,
            activePaymentId: null,
            // Never leave "Cancelled order + Pending payment" on screen.
            ...(order.paymentStatus === PAYMENT_STATUS.PENDING ? { paymentStatus: PAYMENT_STATUS.CANCELLED } : {}),
          }
        : {}),
      updatedAt: deps.serverTimestamp(),
    });

    // Cancel an unpaid order -> its still-PENDING payment attempt dies too,
    // in the SAME transaction.
    for (const p of activePaymentReads) {
      tx.update(p.ref, {
        status: PAYMENT_STATUS.CANCELLED,
        failureReason: 'Order cancelled by admin before payment completed.',
        completedAt: deps.serverTimestamp(),
        updatedAt: deps.serverTimestamp(),
      });
    }

    for (const p of restorePlan) {
      const derived = deriveStock(p.inventory);
      tx.update(p.ref, {
        inventory: p.inventory, // full ARRAY
        stockQuantity: derived.stockQuantity + 0,
        availableSizes: derived.availableSizes,
        updatedAt: deps.serverTimestamp(),
      });
      for (const c of p.changes) {
        tx.set(db.collection('inventoryLogs').doc(), {
          productId: p.ref.id,
          productName: p.data.name ?? null,
          size: c.size,
          previousQuantity: c.previousQuantity,
          newQuantity: c.newQuantity,
          reason: 'ORDER_CANCELLED',
          orderId: order.orderId,
          orderDocumentId,
          actorType: 'ADMIN',
          actorId: actorUid,
          createdAt: deps.serverTimestamp(),
        });
      }
    }
    if (restorePlan.length) tx.update(orderRef, { inventoryReserved: false });

    tx.set(db.collection('orderStatusHistory').doc(), {
      orderId: order.orderId,
      orderDocumentId,
      customerId: order.customerId,
      eventType: 'ORDER_STATUS_CHANGED',
      previousStatus: order.orderStatus,
      newStatus: orderStatus,
      paymentStatus: order.paymentStatus,
      note: typeof note === 'string' ? note : '',
      source: 'ADMIN',
      adminUid: actorUid,
      createdAt: deps.serverTimestamp(),
    });

    tx.set(db.collection('notifications').doc(`${orderDocumentId}-ORDER_${orderStatus}`), {
      customerId: order.customerId,
      orderDocumentId,
      event: 'ORDER_STATUS_CHANGED',
      title: 'Order update',
      body: `Your order is now ${orderStatus.replace(/_/g, ' ').toLowerCase()}.`,
      readAt: null,
      createdAt: deps.serverTimestamp(),
    });

    // Status email queued in the SAME transaction (deterministic key per
    // status; PROCESSING/PROCESSED/OUT_FOR_DELIVERY/DELIVERED/CANCELLED only —
    // queueOrderStatusEmail ignores anything else).
    queueOrderStatusEmail(tx, db, { orderDocumentId, order, orderStatus });

    return { ok: true, emailKey: `${orderDocumentId}-ORDER-${orderStatus}` };
  }).then(result => {
    // After commit: deliver the status email best-effort. Never throws.
    deliverEmailAfterCommit(db, result.emailKey);
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------
// Stale unpaid orders. No cron: called at the start of POST /api/orders/create
// and GET /api/admin/orders. Any PENDING order older than 30 minutes that has
// not been paid (paymentStatus PENDING/FAILED/CANCELLED/TIMEOUT) is CANCELLED,
// its paymentStatus becomes TIMEOUT if still PENDING, and the reserved stock
// is restored as a NEW inventory array plus inventoryLogs — in ONE transaction
// per order. Max 20 orders per call.
// ---------------------------------------------------------------------------
export const STALE_ORDER_MS = 30 * 60_000;
const UNPAID_PAYMENT_STATUSES = ['PENDING', 'FAILED', 'CANCELLED', 'TIMEOUT'];

function msOf(value) {
  if (!value) return null;
  if (typeof value === 'object' && typeof value.toMillis === 'function') return value.toMillis();
  if (typeof value === 'number') return value;
  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : null;
}

export async function expireStaleOrders(db, deps = {}, now = Date.now()) {
  try {
    // Single-field equality query ONLY (no orderBy) — no composite index needed;
    // the stalest 40 candidates are picked in memory.
    const snap = await db.collection('orders')
      .where('orderStatus', '==', 'PENDING')
      .limit(200)
      .get();
    const cutoff = now - STALE_ORDER_MS;
    const candidates = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(o => UNPAID_PAYMENT_STATUSES.includes(o.paymentStatus))
      .filter(o => {
        const created = msOf(o.createdAt);
        return created != null && created <= cutoff;
      })
      .sort((a, b) => (msOf(a.createdAt) ?? 0) - (msOf(b.createdAt) ?? 0)) // oldest first
      .slice(0, 20); // limit 20 per call
    let expired = 0;
    for (const o of candidates) {
      const doc = { id: o.id };

      await db.runTransaction(async tx => {
        const orderRef = db.collection('orders').doc(doc.id);
        const orderSnap = await tx.get(orderRef);
        if (!orderSnap.exists) return;
        const order = orderSnap.data();
        // Re-check inside the transaction — it may have just been paid.
        if (order.orderStatus !== 'PENDING' || !UNPAID_PAYMENT_STATUSES.includes(order.paymentStatus)) return;
        const createdMs = msOf(order.createdAt);
        if (createdMs == null || createdMs > cutoff) return;

        // Reads before writes: products for the stock restore AND the still
        // PENDING payment attempt (never leave "Cancelled order + Pending
        // payment" on the admin screen).
        let activePaymentRead = null;
        if (typeof order.activePaymentId === 'string' && order.activePaymentId) {
          const pSnap = await tx.get(db.collection('payments').doc(order.activePaymentId));
          if (pSnap.exists && pSnap.data().status === PAYMENT_STATUS.PENDING) activePaymentRead = { ref: pSnap.ref, data: pSnap.data() };
        }
        let restorePlan = [];
        if (order.inventoryReserved === true) {
          const byProduct = groupByProduct((order.items || []).map(i => ({ productId: i.productId, size: i.size, quantity: i.quantity })));
          const refs = [...byProduct.keys()].map(id => db.collection('products').doc(id));
          const snaps = refs.length ? await tx.getAll(...refs) : [];
          for (let n = 0; n < snaps.length; n += 1) {
            const s = snaps[n];
            if (!s.exists) continue;
            const data = s.data();
            if (!Array.isArray(data.inventory)) {
              console.error(`INVENTORY_NOT_ARRAY product=${refs[n].id} during stale expiry: needs repair`);
              continue;
            }
            let inventory = data.inventory.map(i => ({ size: i.size, quantity: Number(i.quantity) || 0 }));
            const changes = [];
            for (const line of byProduct.get(refs[n].id)) {
              const before = inventory.find(i => i.size === line.size)?.quantity ?? 0;
              inventory = restoreInventory(inventory, line.size, line.quantity);
              const after = inventory.find(i => i.size === line.size)?.quantity ?? 0;
              changes.push({ ...line, previousQuantity: before, newQuantity: after });
            }
            restorePlan.push({ ref: s.ref, data, inventory, changes });
          }
        }

        await releasePromoUsage(tx, db, order, deps);
        tx.update(orderRef, {
          orderStatus: 'CANCELLED',
          promoReleased: order.promoReleased === true ? true : true,
          ...(order.paymentStatus === PAYMENT_STATUS.PENDING ? { paymentStatus: PAYMENT_STATUS.TIMEOUT } : {}),
          activePaymentId: null,
          ...(restorePlan.length ? { inventoryReserved: false } : {}),
          updatedAt: deps.serverTimestamp(),
        });

        for (const p of restorePlan) {
          const derived = deriveStock(p.inventory);
          tx.update(p.ref, {
            inventory: p.inventory, // full ARRAY — never dotted paths
            stockQuantity: derived.stockQuantity,
            availableSizes: derived.availableSizes,
            updatedAt: deps.serverTimestamp(),
          });
          for (const c of p.changes) {
            tx.set(db.collection('inventoryLogs').doc(), {
              productId: p.ref.id,
              productName: p.data.name ?? null,
              size: c.size,
              previousQuantity: c.previousQuantity,
              newQuantity: c.newQuantity,
              reason: 'ORDER_EXPIRED_RESTORE',
              orderId: order.orderId,
              orderDocumentId: doc.id,
              actorType: 'SYSTEM',
              actorId: 'stale-order-expiry',
              createdAt: deps.serverTimestamp(),
            });
          }
        }

        // The dead payment attempt becomes TIMEOUT in the same transaction.
        if (activePaymentRead) {
          tx.update(activePaymentRead.ref, {
            status: PAYMENT_STATUS.TIMEOUT,
            failureReason: 'The M-Pesa request timed out or was cancelled.',
            completedAt: deps.serverTimestamp(),
            updatedAt: deps.serverTimestamp(),
          });
        }

        tx.set(db.collection('orderStatusHistory').doc(), {
          orderId: order.orderId,
          orderDocumentId: doc.id,
          customerId: order.customerId,
          eventType: 'ORDER_STATUS_CHANGED',
          previousStatus: order.orderStatus,
          newStatus: 'CANCELLED',
          paymentStatus: order.paymentStatus === PAYMENT_STATUS.PENDING ? PAYMENT_STATUS.TIMEOUT : order.paymentStatus,
          note: 'Order expired: no payment received within 30 minutes.',
          source: 'SYSTEM',
          createdAt: deps.serverTimestamp(),
        });

        tx.set(db.collection('notifications').doc(`${doc.id}-ORDER_CANCELLED`), {
          customerId: order.customerId,
          orderDocumentId: doc.id,
          event: 'ORDER_STATUS_CHANGED',
          title: 'Order expired',
          body: `Your order ${order.orderId} was cancelled because we did not receive payment within 30 minutes. You can place it again any time.`,
          readAt: null,
          createdAt: deps.serverTimestamp(),
        });

        expired += 1;
      });
    }
    return { expired };
  } catch (error) {
    // Best-effort housekeeping: a failure here must NEVER block order creation
    // or the admin list. Log loudly and move on.
    console.error('expireStaleOrders failed:', error?.message || error);
    return { expired: 0, error: true };
  }
}

// ---------------------------------------------------------------------------
// Lazy payment reconciliation (no cron needed). Called best-effort from GET
// /api/dashboard, GET /api/admin/orders, GET /api/orders/track and GET
// /api/payments/status so a lost webhook never leaves a payment stuck in
// PENDING on screen. Rules:
//   * only PENDING payments WITH a providerReference initiated > 8 seconds ago
//     are checked (a prompt younger than that is still legitimately pending),
//   * at most `limit` (default 5), newest first, each check capped at 4 seconds
//     and run with Promise.allSettled — one dead provider call cannot hang the
//     page and this function NEVER throws,
//   * any non-PENDING result from the provider is applied via
//     applyVerifiedCallbackCore,
//   * HARD RULE: still PENDING after 180 seconds -> TIMEOUT with reason
//     "The M-Pesa request timed out or was cancelled." so admin/customer UIs
//     show the truth quickly instead of an eternal Pending badge.
// ---------------------------------------------------------------------------
export const RECONCILE_MIN_AGE_MS = 8_000;
// SINGLE SOURCE OF TRUTH for how long a PENDING M-Pesa attempt may live.
// An STK push is only valid ~60-90 s on the customer's phone; after 100 s we
// give up, mark TIMEOUT (restoring stock once) and let the customer retry.
// payments.js and Checkout.tsx (105 s poll) must stay consistent with this.
export const RECONCILE_TIMEOUT_MS = 100_000;
export const RECONCILE_CALL_LIMIT_MS = 4_000;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`reconcile: provider call exceeded ${ms}ms`)), ms)),
  ]);
}

async function applyReconcileResult(db, deps, payment, nextStatus, transactionReference, reason, eventId) {
  try {
    await applyVerifiedCallbackCore(db, deps, {
      providerReference: payment.providerReference || `stale:${payment.paymentId}`,
      status: nextStatus,
      amount: Number(payment.amount),
      transactionReference: transactionReference ?? null,
      eventId,
      source: 'SYSTEM',
      reason,
    });
    return true;
  } catch (error) {
    // Duplicate/idempotent hits are expected when webhook + poll race — not an error.
    console.error(`reconcilePendingPayments apply failed for ${payment.paymentId}: ${error?.message || error}`);
    return false;
  }
}

export async function reconcilePendingPayments(db, options = {}) {
  const {
    customerId = null,
    limit = 5,
    now = Date.now(),
    minAgeMs = RECONCILE_MIN_AGE_MS,
    timeoutMs = RECONCILE_TIMEOUT_MS,
    provider = null,
    deps = { serverTimestamp: () => FieldValue.serverTimestamp() },
  } = options;
  try {
    let q = db.collection('payments').where('status', '==', PAYMENT_STATUS.PENDING);
    if (customerId) q = q.where('customerId', '==', customerId);
    const snap = await q.limit(100).get(); // no orderBy → no composite index needed
    const docs = snap.docs
      .map(d => ({ id: d.id, ...d.data() }))
      .filter(p => {
        const initiatedAt = msOf(p.initiatedAt) ?? msOf(p.createdAt);
        return initiatedAt != null && now - initiatedAt > minAgeMs;
      })
      // newest first, deterministic fallback by id
      .sort((a, b) => {
        const ta = msOf(a.initiatedAt) ?? msOf(a.createdAt) ?? 0;
        const tb = msOf(b.initiatedAt) ?? msOf(b.createdAt) ?? 0;
        if (tb !== ta) return tb - ta;
        return String(a.id).localeCompare(String(b.id));
      })
      .slice(0, limit);
    if (docs.length === 0) return { checked: 0, applied: 0 };

    const mpesaProvider = provider || getMpesaProviderSafe();
    const results = await Promise.allSettled(docs.map(async p => {
      const initiatedAt = msOf(p.initiatedAt) ?? msOf(p.createdAt) ?? now;
      const age = now - initiatedAt;
      // DEAD PROMPT RULE: nothing to ask the provider — apply TIMEOUT directly.
      if (age > timeoutMs) {
        return applyReconcileResult(db, deps, p, PAYMENT_STATUS.TIMEOUT, null,
          'The M-Pesa request timed out or was cancelled.',
          `reconcile-timeout:${p.paymentId}`);
      }
      if (!mpesaProvider || !p.providerReference) return false;
      const result = await withTimeout(mpesaProvider.checkStatus(p.providerReference), RECONCILE_CALL_LIMIT_MS);
      if (result?.status === PAYMENT_STATUS.PENDING) return false;
      return applyReconcileResult(db, deps, p, result.status, result.transactionReference,
        result.reason || null, `reconcile:${p.providerReference}:${result.status}`);
    }));
    const applied = results.filter(r => r.status === 'fulfilled' && r.value === true).length;
    return { checked: docs.length, applied };
  } catch (error) {
    // Best effort ONLY: reconciliation must never break the page it serves.
    console.error(`reconcilePendingPayments failed: ${error?.message || error}`);
    return { checked: 0, applied: 0, error: true };
  }
}

// The env key may be missing (payments disabled) — reconciliation then only
// applies the 180-second hard timeout and skips provider calls.
function getMpesaProviderSafe() {
  try {
    return getMpesaProvider();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Best-effort wrapper used by read endpoints (dashboard, admin orders GET,
// track, payments routes). It NEVER throws and never blocks the page it
// serves: one dead provider call must not turn into a 500 on an unrelated
// GET. Returns a summary object or { checked: 0, applied: 0, error: true }.
// ---------------------------------------------------------------------------
export async function reconcileBestEffort(db, options = {}) {
  try {
    return await reconcilePendingPayments(db, options);
  } catch (error) {
    console.error(`reconcileBestEffort failed: ${error?.message || error}`);
    return { checked: 0, applied: 0, error: true };
  }
}
