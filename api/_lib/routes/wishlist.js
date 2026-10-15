import { adminDb, requireUser } from '../firebase-admin.js';
import { clientError, methodNotAllowed } from '../http.js';

const cleanId = value => String(value ?? '').trim();

export default async function wishlist(req, res) {
  const user = await requireUser(req);
  const items = adminDb.collection('users').doc(user.uid).collection('wishlist');

  if (req.method === 'GET') {
    const snapshot = await items.orderBy('createdAt', 'desc').limit(200).get();
    return res.status(200).json({
      items: snapshot.docs.map(doc => ({
        productId: doc.id,
        createdAt: doc.data().createdAt?.toDate?.().toISOString?.() ?? null,
      })),
    });
  }

  const productId = cleanId(req.body?.productId);
  if (!productId || productId.length > 160 || /[\\/]/.test(productId)) {
    throw clientError('A valid product is required.');
  }

  if (req.method === 'POST') {
    // Ensure the product exists before saving a reference to it.
    const product = await adminDb.collection('products').doc(productId).get();
    if (!product.exists) throw clientError('This product could not be found.', 404);
    await items.doc(productId).set({
      productId,
      createdAt: new Date(),
    }, { merge: true });
    return res.status(200).json({ message: 'Added to your wishlist.', productId });
  }

  if (req.method === 'DELETE') {
    await items.doc(productId).delete();
    return res.status(200).json({ message: 'Removed from your wishlist.', productId });
  }

  return methodNotAllowed(res, 'GET, POST, DELETE');
}
