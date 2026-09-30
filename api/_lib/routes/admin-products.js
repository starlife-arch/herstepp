// Admin product routes (dispatched from api/admin.js):
//   GET/POST /api/admin/products          — list ALL statuses / create
//   PUT      /api/admin/products/:id      — full update (validateProduct)
//   POST     /api/admin/products/:id/archive
//   GET      /api/admin/customers         — real users + PAID order stats
import { FieldValue } from 'firebase-admin/firestore';
import { adminDb, requireAdmin } from '../firebase-admin.js';
import { clientError, methodNotAllowed } from '../http.js';

const statuses = ['DRAFT', 'ACTIVE', 'ARCHIVED'];
const sizes = new Set(Array.from({ length: 16 }, (_, i) => String(i + 30)));

function assert(condition, message) {
  if (!condition) throw clientError(message);
}

// Mirrors the products/{id} contract in AGENTS.md. Sizes are STRINGS "30".."45".
export function validateProduct(input) {
  const p = input && typeof input === 'object' ? input : {};
  assert(typeof p.name === 'string' && p.name.trim().length > 0 && p.name.trim().length <= 160, 'Enter a product name of 160 characters or fewer.');
  assert(typeof p.description === 'string' && p.description.length <= 4000, 'Description must be 4,000 characters or fewer.');
  assert(typeof p.categoryId === 'string' && p.categoryId.trim(), 'Select a category.');
  assert(typeof p.sku === 'string' && /^[A-Z0-9_-]{1,80}$/.test(p.sku), 'SKU must be uppercase letters, numbers, - or _ (max 80).');
  assert(Number.isInteger(p.price) && p.price >= 0, 'Price must be a non-negative whole number.');
  assert(p.salePrice === null || (Number.isInteger(p.salePrice) && p.salePrice < p.price), 'Sale price must be a whole number lower than the price.');
  assert(Array.isArray(p.inventory) && p.inventory.length >= 1, 'Add stock for at least one size.');
  const seen = new Set();
  p.inventory.forEach(i => {
    assert(i && typeof i.size === 'string' && sizes.has(i.size) && !seen.has(i.size) && Number.isInteger(i.quantity) && i.quantity >= 0,
      'Inventory sizes must be unique strings from 30 to 45 with non-negative quantities.');
    seen.add(i.size);
  });
  assert(Array.isArray(p.images) && p.images.length >= 1 && p.images.length <= 8, 'Provide between one and eight images.');
  p.images.forEach(i => assert(i && typeof i.url === 'string' && typeof i.publicId === 'string' && i.resourceType === 'image', 'Images are invalid.'));
  assert(p.video === null || p.video === undefined || (typeof p.video.url === 'string' && typeof p.video.publicId === 'string' && p.video.resourceType === 'video'), 'Video is invalid.');
  assert(statuses.includes(p.status), 'Product status is invalid.');
  ['featured', 'bestseller', 'newArrival'].forEach(k => assert(typeof p[k] === 'boolean', `${k} must be true or false.`));
  const inventory = p.inventory.map(i => ({ size: i.size, quantity: i.quantity }));
  return {
    name: p.name.trim(),
    description: p.description,
    categoryId: p.categoryId.trim(),
    sku: p.sku,
    price: p.price,
    salePrice: p.salePrice,
    inventory, // complete ARRAY — derived fields are recomputed server-side
    images: p.images,
    video: p.video || null,
    status: p.status,
    featured: p.featured,
    bestseller: p.bestseller,
    newArrival: p.newArrival,
    stockQuantity: inventory.reduce((n, i) => n + i.quantity, 0),
    availableSizes: inventory.filter(i => i.quantity > 0).map(i => i.size),
  };
}

function serialize(value) {
  if (value?.toDate) return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(serialize);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, serialize(v)]));
  return value;
}

export async function products(req, res) {
  const admin = await requireAdmin(req);
  if (req.method === 'GET') {
    const s = await adminDb.collection('products').orderBy('createdAt', 'desc').get();
    return res.status(200).json(s.docs.map(d => serialize({ id: d.id, ...d.data() })));
  }
  if (req.method !== 'POST') return methodNotAllowed(res, ['GET', 'POST']);
  const data = validateProduct(req.body);
  const ref = await adminDb.collection('products').add({ ...data, createdAt: FieldValue.serverTimestamp(), updatedAt: FieldValue.serverTimestamp() });
  return res.status(201).json({ id: ref.id });
}

export async function productUpdate(req, res) {
  if (req.method !== 'PUT') return methodNotAllowed(res, 'PUT');
  const admin = await requireAdmin(req);
  const id = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id;
  if (typeof id !== 'string' || !id) throw clientError('Product not found.', 404);
  const ref = adminDb.collection('products').doc(id);
  const old = await ref.get();
  if (!old.exists) throw clientError('Product not found.', 404);
  const data = validateProduct(req.body);
  await adminDb.runTransaction(async tx => {
    tx.update(ref, { ...data, updatedAt: FieldValue.serverTimestamp() });
    const previous = Object.fromEntries((Array.isArray(old.data().inventory) ? old.data().inventory : []).map(i => [i.size, i.quantity]));
    for (const item of data.inventory) {
      if ((previous[item.size] ?? 0) !== item.quantity) {
        tx.set(adminDb.collection('inventoryLogs').doc(), {
          productId: id,
          size: item.size,
          previousQuantity: previous[item.size] || 0,
          newQuantity: item.quantity,
          reason: 'ADMIN_UPDATE',
          actorType: 'ADMIN',
          actorId: admin.uid,
          createdAt: FieldValue.serverTimestamp(),
        });
      }
    }
  });
  return res.status(200).json({ ok: true });
}

export async function productArchive(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
  await requireAdmin(req);
  const id = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id;
  const ref = adminDb.collection('products').doc(id);
  if (!(await ref.get()).exists) throw clientError('Product not found.', 404);
  await ref.update({ status: 'ARCHIVED', updatedAt: FieldValue.serverTimestamp() });
  return res.status(200).json({ ok: true });
}

// GET /api/admin/customers — real users with PAID-order aggregates.
// Only these fields ever leave the server: uid, displayName, email,
// phoneNumber, role, createdAt, orderCount, totalSpent.
export async function customers(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
  await requireAdmin(req);
  const usersSnap = await adminDb.collection('users').get();
  const paidOrdersSnap = await adminDb.collection('orders').where('paymentStatus', '==', 'PAID').get();

  // Group in memory — fine at this scale (hundreds of orders, not millions).
  const statsByCustomer = new Map();
  for (const doc of paidOrdersSnap.docs) {
    const o = doc.data();
    const current = statsByCustomer.get(o.customerId) || { orderCount: 0, totalSpent: 0 };
    current.orderCount += 1;
    current.totalSpent += Number(o.total) || 0;
    statsByCustomer.set(o.customerId, current);
  }

  const iso = v => (v?.toDate ? v.toDate().toISOString() : typeof v === 'string' ? v : null);
  const rows = usersSnap.docs.map(doc => {
    const u = doc.data();
    const stats = statsByCustomer.get(doc.id) || { orderCount: 0, totalSpent: 0 };
    return {
      uid: doc.id,
      displayName: typeof u.displayName === 'string' ? u.displayName : '',
      email: typeof u.email === 'string' ? u.email : '',
      phoneNumber: typeof u.phoneNumber === 'string' ? u.phoneNumber : '',
      role: u.role === 'ADMIN' || u.role === 'SUPER_ADMIN' ? u.role : 'CUSTOMER',
      createdAt: iso(u.createdAt),
      orderCount: stats.orderCount,
      totalSpent: stats.totalSpent,
    };
  });
  rows.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  return res.status(200).json(rows);
}
