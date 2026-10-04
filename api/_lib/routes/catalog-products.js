// Public catalogue reads. These are the hottest routes on the site (every
// Home/Shop visit) and were burning the Firestore 50k/day read quota, so:
//  - responses carry `Cache-Control: public, s-maxage=60, stale-while-revalidate=300`
//    (set via setPublicCache) so Vercel's edge serves repeat visitors without
//    touching Firestore at all for a minute;
//  - an in-process TTL cache (60 s) collapses concurrent cold misses to ONE
//    Firestore read per key per instance.
// Everything else (authenticated/admin routes) stays "private, no-store" via
// the dispatcher default.
import { adminDb } from '../firebase-admin.js';
import { methodNotAllowed } from '../http.js';
import { setPublicCache } from '../route-dispatch.js';

const iso = v => (v?.toDate ? v.toDate().toISOString() : v || null);
function serialize(value) { if (value?.toDate) return value.toDate().toISOString(); if (Array.isArray(value)) return value.map(serialize); if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,serialize(v)])); return value; }
function docData(doc) { return serialize({ id: doc.id, ...doc.data() }); }

// --- tiny in-process TTL cache --------------------------------------------
const ttlMs = 60_000;
const cache = new Map(); // key -> { value, expiresAt }
async function cached(key, loader) {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const value = await loader();
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

export async function listProducts(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
  setPublicCache(res);
  const category = Array.isArray(req.query.category) ? req.query.category[0] : req.query.category;
  const key = `products:${typeof category === 'string' && category ? category : ''}`;
  const body = await cached(key, async () => {
    let query = adminDb.collection('products').where('status', '==', 'ACTIVE');
    if (typeof category === 'string' && category) query = query.where('categoryId', '==', category);
    const snapshot = await query.orderBy('createdAt', 'desc').get();
    return snapshot.docs.map(docData);
  });
  return res.status(200).json(body);
}

export async function productDetail(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
  setPublicCache(res);
  const id = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id;
  if (typeof id !== 'string' || !id) return res.status(404).json({ error: 'Product not found.' });
  const body = await cached(`product:${id}`, async () => {
    const product = await adminDb.collection('products').doc(id).get();
    if (!product.exists || product.data().status !== 'ACTIVE') return null;
    return docData(product);
  });
  if (!body) return res.status(404).json({ error: 'Product not found.' });
  return res.status(200).json(body);
}

export async function listCategories(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
  setPublicCache(res);
  const body = await cached('categories', async () => {
    const snapshot = await adminDb.collection('categories').orderBy('name').get();
    return snapshot.docs.map(docData);
  });
  return res.status(200).json(body);
}
