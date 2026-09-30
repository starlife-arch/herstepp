import { FieldValue } from 'firebase-admin/firestore';
import { adminDb, requireUser } from '../firebase-admin.js';
import { normalizeKenyanPhone } from '../phone.js';
import { clientError, methodNotAllowed } from '../http.js';

const LOCATION = 'Juja Town, Jerry House, near Juja Posta, Outside Shop No. 12';

async function loadCheckoutSettings() {
  const snapshot = await adminDb.doc('settings/checkout').get();
  return snapshot.data() || {};
}

// Delivery fees come only from settings/checkout — never hardcoded. Collection is always free.
function computeDeliveryFee(settings, location) {
  const rates = settings.deliveryRates || {};
  const counties = rates.counties || {};
  const text = typeof location === 'string' ? location.toLowerCase() : '';
  const match = Object.entries(counties).find(([name]) => name && text.includes(String(name).toLowerCase()));
  if (match && Number.isInteger(match[1])) return match[1];
  if (text.includes('juja')) return Number.isInteger(rates.outsideJuja) ? rates.outsideJuja : 100;
  if (text.includes('kiambu')) return Number.isInteger(rates.kiambu) ? rates.kiambu : 200;
  return Number.isInteger(rates.defaultCounty) ? rates.defaultCounty : 500;
}

export async function create(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
  const u = await requireUser(req);
  if (u.email && !u.email_verified) throw clientError('Verify your email before creating an order.');
  const { cart, delivery } = req.body || {};
  if (!Array.isArray(cart) || !cart.length) throw clientError('Your cart is empty.');
  const settings = await loadCheckoutSettings();
  const deliveryEnabled = settings.deliveryEnabled === true;
  const method = delivery?.deliveryMethod === 'COLLECTION' ? 'COLLECTION' : 'DELIVERY';
  if (method === 'DELIVERY' && !deliveryEnabled) throw clientError('Delivery is currently unavailable. Please choose store collection.', 409);
  const phone = normalizeKenyanPhone(delivery?.phone);
  const fee = method === 'COLLECTION' ? 0 : computeDeliveryFee(settings, delivery?.location);
  const id = adminDb.collection('orders').doc();
  let out;
  await adminDb.runTransaction(async t => {
    const ps = await Promise.all(cart.map(x => t.get(adminDb.collection('products').doc(x.productId))));
    let subtotal = 0, items = [];
    for (let n = 0; n < cart.length; n++) {
      const c = cart[n], p = ps[n];
      if (!p.exists || p.data().status !== 'ACTIVE') throw clientError('A product is unavailable.', 409);
      const inv = p.data().inventory.find(i => i.size === c.size);
      if (!inv || !Number.isInteger(c.quantity) || c.quantity < 1 || inv.quantity < c.quantity) throw clientError(`${p.data().name} in size ${c.size} no longer has enough stock.`, 409);
      const price = p.data().salePrice ?? p.data().price;
      subtotal += price * c.quantity;
      items.push({ productId: p.id, name: p.data().name, sku: p.data().sku, categoryId: p.data().categoryId, size: c.size, quantity: c.quantity, unitPrice: price, lineTotal: price * c.quantity, imageUrl: p.data().images[0].url });
      t.update(p.ref, {
        [`inventory.${p.data().inventory.findIndex(i => i.size === c.size)}.quantity`]: inv.quantity - c.quantity,
        stockQuantity: p.data().stockQuantity - c.quantity,
        availableSizes: p.data().inventory.filter(i => (i.size === c.size ? i.quantity - c.quantity : i.quantity) > 0).map(i => i.size),
        updatedAt: FieldValue.serverTimestamp(),
      });
      t.set(adminDb.collection('inventoryLogs').doc(), { productId: p.id, size: c.size, previousQuantity: inv.quantity, newQuantity: inv.quantity - c.quantity, reason: 'ORDER_RESERVED', customerId: u.uid, createdAt: FieldValue.serverTimestamp() });
    }
    const d = method === 'COLLECTION' ? { ...delivery, phone, deliveryMethod: 'COLLECTION', location: LOCATION } : { ...delivery, phone, deliveryMethod: 'DELIVERY' };
    const orderId = `HS-${new Date().getFullYear()}-${String(Date.now()).slice(-6)}`;
    t.set(id, { orderId, customerId: u.uid, customerEmail: u.email || '', items, subtotal, deliveryFee: fee, discount: 0, promoCode: null, total: subtotal + fee, currency: 'KES', paymentStatus: 'PENDING', orderStatus: 'PENDING', inventoryReserved: true, delivery: d, activePaymentId: null, paymentId: null, paymentReference: null, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
    out = { id: id.id, orderId, subtotal, deliveryFee: fee, discount: 0, total: subtotal + fee, paymentStatus: 'PENDING', orderStatus: 'PENDING' };
  });
  return res.status(201).json({ order: out });
}

export async function config(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
  const d = await loadCheckoutSettings();
  return res.json({ collectionEnabled: true, deliveryEnabled: d.deliveryEnabled === true, deliveryRates: d.deliveryEnabled === true ? (d.deliveryRates || null) : null, collectionLocation: LOCATION });
}
