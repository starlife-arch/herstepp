// Customer dashboard data (GET /api/dashboard) and notifications.
// IMPORTANT: every query uses ONLY a single equality filter (where('customerId','==',uid))
// with NO orderBy — composite (customerId ASC + createdAt DESC) indexes are NOT required.
// Sorting happens in memory and results are sliced (50/20/20). orderStatusHistory uses
// where('orderDocumentId','in',chunks of 30) without orderBy, sorted in memory.
// Each section runs isolated so ONE failing query never empties the page; failures are
// logged with the Firestore index link when present and reported to the client via
// `warnings` so the UI can show them instead of silently rendering "No orders yet".
import { adminDb, requireUser } from '../firebase-admin.js';
import { methodNotAllowed, clientError } from '../http.js';
import { reconcilePendingPayments } from '../order-core.js';

const iso = v => (v?.toDate ? v.toDate().toISOString() : v || null);
const rows = s => s.docs.map(d => ({ id: d.id, ...d.data(), createdAt: iso(d.data().createdAt), updatedAt: iso(d.data().updatedAt) }));

// Sort by createdAt descending IN MEMORY (no composite index needed), then slice.
function sortDescByCreatedAt(list) {
  return list
    .slice()
    .sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime());
}

function logQueryFailure(warnings, name, err) {
  // Never let one broken query blank the page — log loudly, warn the client, return [].
  const reason = String(err?.message || err || 'unknown error');
  console.error(`[dashboard] query "${name}" failed: ${reason}`);
  const link = reason.match(/https:\/\/console\.firebase\.com\S+/)?.[0];
  if (link) console.error(`[dashboard] missing index for "${name}": create it here -> ${link}`);
  warnings.push({ section: name, reason: reason.slice(0, 300) });
}

async function settle(promiseFactory, name, warnings) {
  try {
    return await promiseFactory();
  } catch (err) {
    logQueryFailure(warnings, name, err);
    return null;
  }
}

export async function dashboard(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
  const u = await requireUser(req);
  const t0 = Date.now();
  const warnings = [];

  // Lazy reconciliation (best effort, never throws): refresh dead PENDING payments for
  // this user so paid/failed/cancelled/timeout shows correctly without any cron.
  await reconcilePendingPayments(adminDb, { customerId: u.uid }).catch(() => {});
  console.log(`[dashboard] reconcile took ${Date.now() - t0}ms uid=${u.uid}`);

  const t1 = Date.now();
  // Single-field equality queries only — no orderBy, no composite index dependency.
  const [profileSnap, ordersSnap, paymentsSnap, notificationsSnap] = await Promise.all([
    settle(() => adminDb.collection('users').doc(u.uid).get(), 'profile', warnings),
    settle(() => adminDb.collection('orders').where('customerId', '==', u.uid).limit(200).get(), 'orders', warnings),
    settle(() => adminDb.collection('payments').where('customerId', '==', u.uid).limit(100).get(), 'payments', warnings),
    settle(() => adminDb.collection('notifications').where('customerId', '==', u.uid).limit(100).get(), 'notifications', warnings),
  ]);
  console.log(`[dashboard] queries took ${Date.now() - t1}ms uid=${u.uid}`);

  // In-memory sort + slice (50 orders / 20 payments / 20 notifications).
  const ordersAll = sortDescByCreatedAt(ordersSnap ? rows(ordersSnap) : []).slice(0, 50);
  const payments = sortDescByCreatedAt(paymentsSnap ? rows(paymentsSnap) : []).slice(0, 20);
  const notifications = sortDescByCreatedAt(notificationsSnap ? rows(notificationsSnap) : []).slice(0, 20);

  // Attach each order's status history in batched queries of 30 doc ids, WITHOUT orderBy
  // (composite index not required); sort ascending in memory. A failure leaves histories empty.
  const historyByDoc = {};
  const orderIds = ordersAll.map(o => o.id).filter(Boolean);
  if (orderIds.length > 0) {
    const chunks = [];
    for (let i = 0; i < orderIds.length; i += 30) chunks.push(orderIds.slice(i, i + 30));
    const results = await Promise.allSettled(
      chunks.map(chunk => adminDb.collection('orderStatusHistory').where('orderDocumentId', 'in', chunk).limit(500).get()),
    );
    results.forEach((r, idx) => {
      if (r.status === 'fulfilled') {
        for (const h of r.value.docs) {
          const hd = h.data();
          const key = hd.orderDocumentId;
          if (!historyByDoc[key]) historyByDoc[key] = [];
          historyByDoc[key].push({ ...hd, createdAt: iso(hd.createdAt) });
        }
      } else {
        logQueryFailure(warnings, `status-history-chunk-${idx}`, r.reason);
      }
    });
    for (const key of Object.keys(historyByDoc)) {
      historyByDoc[key].sort((a, b) => new Date(a.createdAt ?? 0).getTime() - new Date(b.createdAt ?? 0).getTime());
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
    orders: ordersAll.map(o => ({ ...o, statusHistory: historyByDoc[o.id] ?? [] })),
    payments,
    notifications,
    warnings,
  });
}

export async function notifications(req, res) {
  const u = await requireUser(req);
  if (req.method === 'GET') {
    const warnings = [];
    // No orderBy → no composite index needed; sort in memory.
    const snap = await settle(
      () => adminDb.collection('notifications').where('customerId', '==', u.uid).limit(100).get(),
      'notifications/list',
      warnings,
    );
    return res.json(sortDescByCreatedAt(snap ? rows(snap) : []).slice(0, 50));
  }
  if (req.method !== 'PATCH') return methodNotAllowed(res, ['GET', 'PATCH']);
  const id = Array.isArray(req.query.id) ? req.query.id[0] : req.query.id;
  if (typeof id !== 'string' || !id) throw clientError('Notification id is required.', 400);
  const s = await adminDb.collection('notifications').doc(id).get();
  if (!s.exists) throw clientError('Notification not found.', 404);
  if (s.data()?.customerId !== u.uid) throw clientError('You can only update your own notifications.', 403);
  await s.ref.update({ readAt: new Date() });
  return res.json({ ok: true });
}
