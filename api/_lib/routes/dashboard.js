// Customer dashboard data (GET /api/dashboard) and notifications.
// Each query runs with Promise.allSettled so ONE failing query (e.g. a
// missing composite index) never empties the whole page: the failed section
// returns an empty array and the error is logged with its Firestore index
// link when available.
import { adminDb, requireUser } from '../firebase-admin.js';
import { methodNotAllowed, clientError } from '../http.js';

const iso = v => (v?.toDate ? v.toDate().toISOString() : v || null);
const rows = s => s.docs.map(d => ({ id: d.id, ...d.data(), createdAt: iso(d.data().createdAt), updatedAt: iso(d.data().updatedAt) }));

function logQueryFailure(name, err) {
  // Never let one broken query blank the page — log loudly and return [].
  console.error(`[dashboard] query "${name}" failed: ${err?.message || err}`);
  const link = String(err?.message || '').match(/https:\/\/console\.firebase\.com\S+/)?.[0];
  if (link) console.error(`[dashboard] missing index for "${name}": create it here -> ${link}`);
}

async function settle(promiseFactory, name) {
  const [res] = await Promise.allSettled([promiseFactory()]);
  if (res.status === 'fulfilled') return res.value;
  logQueryFailure(name, res.reason);
  return null;
}

export async function dashboard(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
  const u = await requireUser(req);

  const profileSnap = await settle(() => adminDb.collection('users').doc(u.uid).get(), 'profile');
  const ordersSnap = await settle(
    () => adminDb.collection('orders').where('customerId', '==', u.uid).orderBy('createdAt', 'desc').limit(50).get(),
    'orders',
  );
  const paymentsSnap = await settle(
    () => adminDb.collection('payments').where('customerId', '==', u.uid).orderBy('createdAt', 'desc').limit(20).get(),
    'payments',
  );
  const notificationsSnap = await settle(
    () => adminDb.collection('notifications').where('customerId', '==', u.uid).orderBy('createdAt', 'desc').limit(20).get(),
    'notifications',
  );

  // Attach each order's status history in ONE query (batched by doc ids) so
  // the dashboard timeline works without N+1 reads. A failure here must not
  // empty the page — history simply stays empty for every order.
  let historyByDoc = {};
  const orderDocs = ordersSnap ? ordersSnap.docs : [];
  if (orderDocs.length > 0) {
    try {
      const hist = await adminDb
        .collection('orderStatusHistory')
        .where('orderDocumentId', 'in', orderDocs.map(d => d.id))
        .orderBy('createdAt', 'asc')
        .limit(500)
        .get();
      for (const h of hist.docs) {
        const hd = h.data();
        const key = hd.orderDocumentId;
        if (!historyByDoc[key]) historyByDoc[key] = [];
        historyByDoc[key].push({ ...hd, createdAt: iso(hd.createdAt) });
      }
    } catch (err) {
      logQueryFailure('status-history', err);
    }
  }

  const p = profileSnap?.data?.() || {};
  return res.json({
    profile: {
      displayName: p.displayName ?? '',
      email: p.email ?? u.email ?? '',
      phoneNumber: p.phoneNumber ?? '',
      deliveryDetails: p.deliveryDetails ?? null,
    },
    orders: orderDocs.map(d => ({
      id: d.id,
      ...d.data(),
      createdAt: iso(d.data().createdAt),
      updatedAt: iso(d.data().updatedAt),
      statusHistory: historyByDoc[d.id] ?? [],
    })),
    payments: paymentsSnap ? rows(paymentsSnap) : [],
    notifications: notificationsSnap ? rows(notificationsSnap) : [],
  });
}

export async function notifications(req, res) {
  const u = await requireUser(req);
  if (req.method === 'GET') {
    const snap = await settle(
      () => adminDb.collection('notifications').where('customerId', '==', u.uid).orderBy('createdAt', 'desc').limit(50).get(),
      'notifications/list',
    );
    return res.json(snap ? rows(snap) : []);
  }
  if (req.method !== 'PATCH') return methodNotAllowed(res, ['GET', 'PATCH']);
  const id = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id;
  if (typeof id !== 'string' || !id) throw clientError('Notification id is required.', 400);
  const s = await adminDb.collection('notifications').doc(id).get();
  if (!s.exists) throw clientError('Notification not found.', 404);
  if (s.data().customerId !== u.uid) throw clientError('Forbidden.', 403);
  if (!s.data().readAt) await s.ref.update({ readAt: new Date() });
  return res.json({ ok: true });
}
