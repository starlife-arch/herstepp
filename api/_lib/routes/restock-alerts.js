import { createHash } from 'node:crypto';
import { adminDb, requireUser } from '../firebase-admin.js';
import { clientError, methodNotAllowed } from '../http.js';

const clean = value => String(value ?? '').trim();
const subscriptionId = (uid, productId, size) => createHash('sha256').update(uid + ':' + productId + ':' + size).digest('hex');

export default async function restockAlerts(req, res) {
  const user = await requireUser(req);
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
  const productId = clean(req.body?.productId);
  const size = clean(req.body?.size);
  if (!productId || productId.length > 160 || !/^(3[0-9]|4[0-5])$/.test(size)) throw clientError('Choose a valid product and shoe size.');
  const productSnap = await adminDb.collection('products').doc(productId).get();
  if (!productSnap.exists || productSnap.data()?.status !== 'ACTIVE') throw clientError('This product is unavailable.', 404);
  const product = productSnap.data();
  const variant = (Array.isArray(product.inventory) ? product.inventory : []).find(item => String(item.size) === size);
  if (!variant) throw clientError('That size is not offered for this product.');
  if (Number(variant.quantity) > 0) throw clientError('This size is already in stock. You can select it above.');
  const profileSnap = await adminDb.collection('users').doc(user.uid).get();
  const profile = profileSnap.data() || {};
  const email = clean(profile.email || user.email).toLowerCase();
  if (!email || !email.includes('@')) throw clientError('Add an email address to your account before setting a restock alert.');
  const ref = adminDb.collection('restockSubscriptions').doc(subscriptionId(user.uid, productId, size));
  await ref.set({ userId: user.uid, productId, productName: clean(product.name).slice(0, 160), size, email, status: 'ACTIVE', createdAt: new Date(), updatedAt: new Date() }, { merge: true });
  return res.status(201).json({ subscribed: true, message: 'We will email you when size ' + size + ' is back in stock.' });
}
