import { FieldValue } from 'firebase-admin/firestore';
import { adminDb, requireUser } from '../firebase-admin.js';
import { clientError, methodNotAllowed } from '../http.js';

const clean = value => String(value ?? '').trim();
const sizes = new Set([...Array.from({ length: 16 }, (_, i) => String(i + 30)), 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'One Size', 'Free Size']);

function validateDraft(input) {
  const p = input && typeof input === 'object' ? input : {};
  const name = clean(p.name);
  const description = String(p.description ?? '').trim();
  const categoryId = clean(p.categoryId);
  const sku = clean(p.sku).toUpperCase();
  if (name.length < 2 || name.length > 160) throw clientError('Product name must be between 2 and 160 characters.');
  if (description.length > 4000) throw clientError('Description must be 4,000 characters or fewer.');
  if (!categoryId || categoryId.length > 100) throw clientError('Select a valid product category.');
  if (!/^[A-Z0-9_-]{1,80}$/.test(sku)) throw clientError('SKU must use uppercase letters, numbers, - or _ (max 80).');
  if (!Number.isInteger(p.price) || p.price < 0) throw clientError('Price must be a non-negative whole KSh amount.');
  if (p.salePrice !== null && p.salePrice !== undefined && (!Number.isInteger(p.salePrice) || p.salePrice < 0 || p.salePrice >= p.price)) {
    throw clientError('Sale price must be a whole number lower than the regular price.');
  }
  if (!Array.isArray(p.inventory) || p.inventory.length < 1 || p.inventory.length > 40) throw clientError('Add stock for at least one size or variant.');
  const seen = new Set();
  const inventory = p.inventory.map(item => {
    if (!item || typeof item.size !== 'string' || !sizes.has(item.size) || seen.has(item.size) ||
      !Number.isInteger(item.quantity) || item.quantity < 0 ||
      (item.costPrice !== undefined && item.costPrice !== null && item.costPrice !== '' && (!Number.isInteger(item.costPrice) || item.costPrice < 0))) {
      throw clientError('Inventory must use unique supported sizes and non-negative whole-number quantities/costs.');
    }
    seen.add(item.size);
    return { size: item.size, quantity: item.quantity, costPrice: item.costPrice === undefined || item.costPrice === '' ? null : item.costPrice };
  });
  if (!Array.isArray(p.images) || p.images.length < 1 || p.images.length > 8 ||
    p.images.some(i => !i || typeof i.url !== 'string' || !/^https:\/\//i.test(i.url) ||
      typeof i.publicId !== 'string' || i.resourceType !== 'image')) {
    throw clientError('Provide 1–8 valid uploaded product images.');
  }
  return {
    name, description, categoryId, sku, price: p.price,
    salePrice: p.salePrice ?? null, inventory, images: p.images,
    video: null, status: 'DRAFT', featured: false, bestseller: false, newArrival: false,
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

export default async function sellerProducts(req, res) {
  const user = await requireUser(req);
  const sellerRef = adminDb.collection('sellers').doc(user.uid);
  const sellerSnap = await sellerRef.get();
  if (!sellerSnap.exists || sellerSnap.data()?.status !== 'ACTIVE') {
    throw clientError('Only approved, active sellers can manage product drafts.', 403);
  }
  if (req.method === 'GET') {
    const snapshot = await adminDb.collection('sellerProducts').where('sellerUid', '==', user.uid).get();
    const products = snapshot.docs.map(doc => serialize({ id: doc.id, ...doc.data() }))
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
    return res.status(200).json({ products, publishingEnabled: false });
  }
  if (req.method !== 'POST') return methodNotAllowed(res, 'GET, POST');

  const product = validateDraft(req.body);
  const category = await adminDb.collection('categories').doc(product.categoryId).get();
  if (!category.exists) throw clientError('The selected category does not exist.');
  const duplicate = await adminDb.collection('sellerProducts')
    .where('sellerUid', '==', user.uid).where('sku', '==', product.sku).limit(1).get();
  if (!duplicate.empty) throw clientError('You already have a product draft with this SKU.');

  const now = FieldValue.serverTimestamp();
  const ref = await adminDb.collection('sellerProducts').add({
    ...product,
    sellerUid: user.uid,
    sellerDisplayName: clean(sellerSnap.data()?.displayName).slice(0, 60),
    createdAt: now,
    updatedAt: now,
  });
  return res.status(201).json({
    product: { id: ref.id, ...product, status: 'DRAFT' },
    message: 'Product saved as a private draft. It is not visible in the public shop.',
  });
}
