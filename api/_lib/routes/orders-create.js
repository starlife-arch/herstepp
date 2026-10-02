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
import { createOrderCore, expireStaleOrders } from '../order-core.js';
import { COLLECTION_LOCATION, normalizeDelivery } from '../delivery.js';

const LOCATION = COLLECTION_LOCATION;

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
  const t0 = Date.now();
  rateLimitOrders(u.uid);
  // SPEED: expireStaleOrders is NOT run on the hot path any more (it used to
  // add seconds to every order). Housekeeping runs from GET /api/admin/orders,
  // GET /api/dashboard and best-effort AFTER this response is sent.
  const { cart, delivery } = req.body || {};
  // Email comes from the VERIFIED TOKEN only — the client never has to send
  // delivery.email (that was the "Email address is required." 400 bug).
  const tokenEmail = typeof u.email === 'string' ? u.email.trim().toLowerCase() : '';
  const result = await createOrderCore(adminDb, {
    serverTimestamp: () => FieldValue.serverTimestamp(),
    normalizePhone: normalizeKenyanPhone,
    constants: { LOCATION },
  }, {
    uid: u.uid,
    email: tokenEmail,
    emailVerified: u.email_verified === true,
    cart,
    delivery,
  });
  return res.status(201).json(result);
}

export async function config(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
  const snapshot = await adminDb.doc('settings/checkout').get();
  const delivery = normalizeDelivery(snapshot.exists ? snapshot.data() || {} : {});
  return res.json({
    collectionEnabled: true,
    collectionLocation: LOCATION,
    deliveryEnabled: delivery.deliveryEnabled,
    deliveryRates: delivery.deliveryRates,
  });
}
