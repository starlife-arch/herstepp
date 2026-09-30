// Pure order/payment logic shared by the HTTP routes and the offline test suite.
// Every Firestore access goes through the injected `db`, so this module can run
// against a fake in-memory Firestore (`node scripts/test-order-core.mjs`).
//
// CRITICAL RULE: product.inventory is an ARRAY in Firestore. It must always be
// written back as a complete new array — never with dotted paths like
// `inventory.0.quantity`, which Firestore turns into a map and corrupts the doc.
import { clientError } from './http.js';

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

const STATUSES_LIKE = new Set(['string', 'number']);

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

export function computeDeliveryFee(settings, location) {
  const rates = settings?.deliveryRates || {};
  const counties = rates.counties || {};
  const text = typeof location === 'string' ? location.toLowerCase() : '';
  const match = Object.entries(counties).find(([name]) => name && text.includes(String(name).toLowerCase()));
  if (match && Number.isInteger(match[1])) return match[1];
  if (text.includes('juja')) return Number.isInteger(rates.outsideJuja) ? rates.outsideJuja : 100;
  if (text.includes('kiambu')) return Number.isInteger(rates.kiambu) ? rates.kiambu : 200;
  return Number.isInteger(rates.defaultCounty) ? rates.defaultCounty : 500;
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
export async function createOrderCore(db, deps, { uid, email, emailVerified, cart, delivery }) {
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

    const deliveryFee = method === 'COLLECTION' ? 0 : computeDeliveryFee(settings, location);
    const discount = 0; // promotions arrive in Phase 2 — always zero for now
    const total = subtotal + deliveryFee - discount;
    if (!Number.isInteger(total) || total <= 0) throw clientError('We could not calculate the order total.');

    // ---- ALL WRITES SECOND -----------------------------------------------
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

    // Idempotency safety net: a terminal payment never changes again. If the
    // same truth arrives through another event id (e.g. webhook + poll race),
    // do nothing instead of double-restoring stock or double-writing history.
    const TERMINAL_STATUSES = ['PAID', 'FAILED', 'CANCELLED', 'TIMEOUT', 'REFUNDED'];
    if (TERMINAL_STATUSES.includes(payment.status)) {
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
    if (!(ALLOWED_PAYMENT_TRANSITIONS[from] || []).includes(status)) {
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

    return { duplicate: false, status, paymentId: paymentRef.id, restored };
  });
}

// ---------------------------------------------------------------------------
// Admin PATCH /api/admin/orders — status transitions. Cancelling an UNPAID
// order restores reserved stock in the same transaction (new inventory arrays
// plus inventoryLogs).
// ---------------------------------------------------------------------------
const TRANSITIONS = {
  PENDING: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['PROCESSED', 'CANCELLED'],
  PROCESSED: ['OUT_FOR_DELIVERY', 'CANCELLED'],
  OUT_FOR_DELIVERY: ['DELIVERED'],
};

export async function adminOrderTransitionCore(db, deps, { actorUid, orderDocumentId, orderStatus, note }) {
  if (typeof orderDocumentId !== 'string' || !orderDocumentId) throw clientError('orderDocumentId is required.');
  if (typeof orderStatus !== 'string' || !TRANSITIONS[orderStatus] && !['CANCELLED'].includes(orderStatus)) throw clientError('A valid orderStatus is required.');
  if (!STATUSES_LIKE.has(typeof orderStatus)) throw clientError('A valid orderStatus is required.');

  return db.runTransaction(async tx => {
    const orderRef = db.collection('orders').doc(orderDocumentId);
    const orderSnap = await tx.get(orderRef);
    if (!orderSnap.exists) throw clientError('Order not found.', 404);
    const order = orderSnap.data();

    const allowed = TRANSITIONS[order.orderStatus] || [];
    if (!allowed.includes(orderStatus)) throw clientError('That order status transition is not allowed.', 409);
    if (orderStatus === 'PROCESSING' && order.paymentStatus !== 'PAID') throw clientError('Payment must be confirmed before processing.', 409);

    // Reads needed for a possible stock restore must happen before writes.
    let restorePlan = [];
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

    tx.update(orderRef, {
      orderStatus,
      ...(orderStatus === 'CANCELLED' ? { activePaymentId: null } : {}),
      updatedAt: deps.serverTimestamp(),
    });

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

    return { ok: true };
  });
}
