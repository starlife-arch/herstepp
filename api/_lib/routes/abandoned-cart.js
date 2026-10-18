import { FieldValue } from 'firebase-admin/firestore';
import { adminDb, requireUser } from '../firebase-admin.js';
import { clientError, methodNotAllowed } from '../http.js';
import { buildEmail } from '../email-templates.js';
import { queueEmail, deliverQueuedEmailInline } from '../email-service.js';
import { siteUrl } from '../site-url.js';

const MAX_LINES = 12;
const MAX_QTY = 10;
const validSize = value => typeof value === 'string' && /^3[0-9]$|^4[0-5]$/.test(value);

export async function snapshot(req, res) {
  if (req.method !== 'POST') return methodNotAllowed(res, 'POST');
  const user = await requireUser(req);
  const uid = user.uid;
  const ref = adminDb.collection('abandonedCarts').doc(uid);
  const rawItems = Array.isArray(req.body?.items) ? req.body.items : [];

  // An empty cart clears any previous reminder candidate immediately.
  if (rawItems.length === 0) {
    await ref.set({
      uid,
      items: [],
      status: 'CLEARED',
      lastActivityAt: FieldValue.serverTimestamp(),
      reminderSentAt: null,
    }, { merge: true });
    return res.status(200).json({ ok: true, tracked: false });
  }

  if (rawItems.length > MAX_LINES) throw clientError('Your cart has too many items to track.');
  const lines = [];
  const seen = new Set();
  for (const raw of rawItems) {
    const productId = String(raw?.productId ?? '').trim();
    const size = String(raw?.size ?? '').trim();
    const quantity = Number(raw?.quantity);
    const key = productId + '|' + size;
    if (!productId || productId.length > 160 || /[\\/]/.test(productId) || !validSize(size)
      || !Number.isInteger(quantity) || quantity < 1 || quantity > MAX_QTY || seen.has(key)) {
      throw clientError('The cart contains an invalid item.');
    }
    seen.add(key);
    lines.push({ productId, size, quantity });
  }

  // Validate against the live catalogue on the server; never trust prices or names
  // supplied by the browser. Do not reserve stock or affect checkout inventory.
  const productSnaps = await Promise.all(lines.map(line => adminDb.collection('products').doc(line.productId).get()));
  const items = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const productSnap = productSnaps[i];
    if (!productSnap.exists) continue;
    const product = productSnap.data() || {};
    if (product.status !== 'ACTIVE' || !Array.isArray(product.inventory)) continue;
    const stock = product.inventory.find(row => String(row?.size) === line.size && Number(row?.quantity) > 0);
    if (!stock) continue;
    items.push({
      productId: line.productId,
      name: String(product.name || 'HerStep shoe').slice(0, 120),
      size: line.size,
      quantity: Math.min(line.quantity, Number(stock.quantity), MAX_QTY),
    });
  }

  if (!items.length) {
    await ref.set({ uid, items: [], status: 'CLEARED', lastActivityAt: FieldValue.serverTimestamp(), reminderSentAt: null }, { merge: true });
    return res.status(200).json({ ok: true, tracked: false });
  }

  const profile = await adminDb.collection('users').doc(uid).get();
  const profileData = profile.exists ? profile.data() || {} : {};
  const email = String(user.email || profileData.email || '').trim().toLowerCase();
  const emailVerified = user.email_verified === true || profileData.emailVerified === true;

  await ref.set({
    uid,
    email,
    emailVerified,
    marketingOptIn: profileData.marketingOptIn === true,
    items,
    status: 'ACTIVE',
    lastActivityAt: FieldValue.serverTimestamp(),
    reminderSentAt: null,
    updatedAt: FieldValue.serverTimestamp(),
  }, { merge: true });

  return res.status(200).json({ ok: true, tracked: true });
}

function millis(value) {
  if (value?.toMillis) return value.toMillis();
  if (value?.toDate) return value.toDate().getTime();
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

export async function processAbandonedCarts(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') return methodNotAllowed(res, 'GET, POST');
  const expected = String(process.env.CRON_SECRET || '').trim();
  const supplied = String(req.headers?.authorization || '').replace(/^Bearer\s+/i, '').trim();
  if (!expected || supplied.length !== expected.length || supplied !== expected) {
    return res.status(401).json({ error: 'Unauthorized.' });
  }

  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  const snap = await adminDb.collection('abandonedCarts').where('status', '==', 'ACTIVE').limit(100).get();
  let eligible = 0;
  let queued = 0;
  let skipped = 0;

  for (const cartDoc of snap.docs) {
    const cart = cartDoc.data() || {};
    const uid = cartDoc.id;
    if (millis(cart.lastActivityAt) > cutoff || cart.reminderSentAt || !cart.marketingOptIn
      || !cart.emailVerified || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(cart.email || ''))
      || !Array.isArray(cart.items) || !cart.items.length) {
      skipped += 1;
      continue;
    }

    // A completed order created after the last cart activity supersedes the reminder.
    const orders = await adminDb.collection('orders').where('customerId', '==', uid).limit(50).get().catch(() => null);
    const lastActivity = millis(cart.lastActivityAt);
    const hasRecentOrder = Boolean(orders?.docs.some(doc => {
      const order = doc.data() || {};
      const created = millis(order.createdAt);
      const paid = String(order.paymentStatus || '').toUpperCase() === 'PAID';
      const completed = ['PROCESSING', 'PROCESSED', 'OUT_FOR_DELIVERY', 'DELIVERED'].includes(String(order.orderStatus || '').toUpperCase());
      return created >= lastActivity && (paid || completed);
    }));
    if (hasRecentOrder) {
      await cartDoc.ref.set({ status: 'ORDERED', updatedAt: FieldValue.serverTimestamp() }, { merge: true });
      skipped += 1;
      continue;
    }

    eligible += 1;
    const currentProfile = await adminDb.collection('users').doc(uid).get().catch(() => null);
    const profile = currentProfile?.exists ? currentProfile.data() || {} : {};
    // Recheck consent and email status at send time in case the customer opted out.
    if (profile.marketingOptIn !== true || profile.emailVerified !== true) {
      skipped += 1;
      continue;
    }

    const key = 'ABANDONED-CART-' + uid + '-' + String(lastActivity);
    const itemSummary = cart.items.slice(0, MAX_LINES)
      .map(item => item.name + ' — size ' + item.size + ' × ' + item.quantity)
      .join('\n');
    const { subject, htmlContent } = buildEmail(
      'Still thinking it over?',
      'You left these items in your HerStep Collection cart:\n\n' + itemSummary
        + '\n\nIf you still want them, you can return to your cart. Availability and prices may change.',
      { ctaLabel: 'Return to your cart', ctaUrl: siteUrl() + '/cart' },
    );

    try {
      await adminDb.runTransaction(async tx => {
        const fresh = await tx.get(cartDoc.ref);
        const data = fresh.exists ? fresh.data() || {} : {};
        if (!fresh.exists || data.status !== 'ACTIVE' || data.reminderSentAt
          || millis(data.lastActivityAt) !== lastActivity || data.marketingOptIn !== true) return;
        queueEmail(tx, adminDb, { key, purpose: 'promotions', to: cart.email, subject, htmlContent });
        tx.update(cartDoc.ref, {
          reminderSentAt: FieldValue.serverTimestamp(),
          status: 'REMINDER_QUEUED',
          updatedAt: FieldValue.serverTimestamp(),
        });
      });
      const queuedDoc = await adminDb.collection('emailOutbox').doc(key.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 180)).get();
      if (!queuedDoc.exists) {
        skipped += 1;
        continue;
      }

      // Do not treat "queued" as "sent". The previous fire-and-forget path left
      // failed carts in REMINDER_QUEUED forever, while the cron only scans ACTIVE
      // carts. Await the existing outbox delivery helper and make failures retryable.
      const delivery = await deliverQueuedEmailInline(adminDb, key);
      if (delivery?.sent === true) {
        await cartDoc.ref.set({
          status: 'REMINDER_SENT',
          reminderSentAt: FieldValue.serverTimestamp(),
          lastReminderError: null,
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        queued += 1;
      } else {
        await cartDoc.ref.set({
          status: 'ACTIVE',
          reminderSentAt: null,
          lastReminderError: String(delivery?.error || delivery?.reason || 'Email delivery did not complete.').slice(0, 300),
          updatedAt: FieldValue.serverTimestamp(),
        }, { merge: true });
        skipped += 1;
      }
    } catch (error) {
      console.error('[abandoned-cart] candidate failed:', error?.message || error);
      skipped += 1;
    }
  }

  return res.status(200).json({ ok: true, checked: snap.size, eligible, queued, skipped });
}
