// POST /api/orders/create — thin HTTP wrapper around api/_lib/order-core.js.
// All validation, pricing, stock reservation and order numbering happen in
// order-core (unit-tested offline against a fake Firestore). This file only:
//   1. authenticates the caller,
//   2. enforces a per-user rate limit of 5 orders per minute,
//   3. maps the request to createOrderCore() and back to a response.
//
// CRITICAL: never update product inventory with dotted paths here — see
// order-core.js. Inventory is always written as a complete new ARRAY.
import { FieldValue } from 'firebase-admin/firestore';
import { adminDb, requireUser } from '../firebase-admin.js';
import { normalizeKenyanPhone } from '../phone.js';
import { clientError, methodNotAllowed } from '../http.js';
import { createOrderCore } from '../order-core.js';

const LOCATION = 'Juja Town, Jerry House, near Juja Posta, Outside Shop No. 12';

// Simple in-memory per-instance limiter (5 orders / minute / user). It is a
// courtesy guard against hammering; prices and stock are still revalidated
// inside the Firestore transaction regardless.
const WINDOW_MS = 60_000;
const MAX_PER_WINDOW = 5;
const attempts = new Map();
export function rateLimitOrders(uid) {
  const now = Date.now();
  const hits = (attempts.get(uid) || []).filter(t => now - t < WINDOW_MS);
  if (hits.length >= MAX_PER_WINDOW) {
    attempts.set(uid, hits);
    throw clientError('Too many orders at once. Please wait a minute and try again.', 429);
  }
  hits.push(now);
  attempts.set(uid, hits);
}

export async function create(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
  const u = await requireUser(req);
  rateLimitOrders(u.uid);
  const { cart, delivery } = req.body || {};
  const result = await createOrderCore(adminDb, {
    serverTimestamp: () => FieldValue.serverTimestamp(),
    normalizePhone: normalizeKenyanPhone,
    constants: { LOCATION },
  }, {
    uid: u.uid,
    email: u.email,
    emailVerified: u.email_verified === true,
    cart,
    delivery,
  });
  return res.status(201).json(result);
}

export async function config(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
  const snapshot = await adminDb.doc('settings/checkout').get();
  const d = snapshot.exists ? snapshot.data() || {} : {};
  return res.json({
    collectionEnabled: true,
    collectionLocation: LOCATION,
    deliveryEnabled: d.deliveryEnabled === true,
    deliveryRates: d.deliveryEnabled === true ? (d.deliveryRates || null) : null,
  });
}
