// Customer dashboard data (GET /api/dashboard) and notifications.
// IMPORTANT: every list query uses orderBy('createdAt','desc') so the NEWEST
// items always come back (a plain where+limit returns the first N by DOCUMENT
// ID, which hid recent orders/notifications once a customer had >N docs).
// The composite indexes (customerId ASC + createdAt DESC) for orders,
// payments and notifications live in firebase/firestore.indexes.json. If
// Firestore answers FAILED_PRECONDITION because the index is still building,
// each query falls back to the equality-only form with limit(300), sorts in
// memory and slices — and the response carries the warning
// "Some history may be missing while the database index is being set up".
// Each section runs isolated so ONE failing query never empties the page;
// failures are logged with the Firestore index link when present and reported
// to the client via `warnings` so the UI can show them instead of silently
// rendering "No orders yet".
import { adminDb, requireUser } from '../firebase-admin.js';
import { methodNotAllowed, clientError } from '../http.js';
import { reconcileBestEffort, PAYMENT_STATUS } from '../order-core.js';

const iso = v => (v?.toDate ? v.toDate().toISOString() : v || null);
const rows = s => s.docs.map(d => ({ id: d.id, ...d.data(), createdAt: iso(d.data().createdAt), updatedAt: iso(d.data().updatedAt) }));

// Sort by createdAt descending IN MEMORY (used on the fallback path), then slice.
function sortDescByCreatedAt(list) {
  return list
    .slice()
    .sort((a, b) => new Date(b.createdAt ?? 0).getTime() - new Date(a.createdAt ?? 0).getTime());
}

// Exact wording the UI shows while a composite index is still building.
export const INDEX_BUILDING_WARNING = 'Some history may be missing while the database index is being set up';

function isFailedPrecondition(err) {
  const code = String(err?.code ?? '').toUpperCase();
  if (code === 'FAILED_PRECONDITION' || code === '9') return true;
  return /FAILED_PRECONDITION/i.test(String(err?.message || err || ''));
}

// Newest-first collection query: orderBy('createdAt','desc').limit(n) when the
// composite index exists; otherwise the equality-only query with limit(300),
// sorted in memory and sliced, plus one warning per section (never duplicated).
async function newestByCreatedAt(db, collectionName, uid, n, warnings) {
  try {
    const snap = await db.collection(collectionName)
      .where('customerId', '==', uid)
      .orderBy('createdAt', 'desc')
      .limit(n)
      .get();
    return rows(snap);
  } catch (err) {
    if (!isFailedPrecondition(err)) throw err;
    if (!warnings.some(w => w.section === collectionName && w.reason === INDEX_BUILDING_WARNING)) {
      warnings.push({ section: collectionName, reason: INDEX_BUILDING_WARNING });
    }
    console.warn(`[dashboard] ${collectionName}: customerId+createdAt DESC index missing — using in-memory fallback`);
    const snap = await db.collection(collectionName).where('customerId', '==', uid).limit(300).get();
    return sortDescByCreatedAt(rows(snap)).slice(0, n);
  }
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

  // CUT DASHBOARD READS: reconciliation now runs ONLY when a cheap probe
  // (customerId + status equality, limit 3 — at most 3 index reads) actually
  // finds a pending payment for this customer. No pending → zero provider
  // work, zero extra reads.
  const pendingProbe = await settle(
    () => adminDb.collection('payments')
      .where('customerId', '==', u.uid)
      .where('status', '==', PAYMENT_STATUS.PENDING)
      .limit(3)
      .get(),
    'pending-probe',
    warnings,
  );
  if (pendingProbe && !pendingProbe.empty) {
    await reconcileBestEffort(adminDb, { customerId: u.uid });
    console.log(`[dashboard] reconcile took ${Date.now() - t0}ms uid=${u.uid}`);
  }

  const t1 = Date.now();
  // Newest-first: orderBy('createdAt','desc') + limit, backed by the composite
  // indexes in firebase/firestore.indexes.json. FAILED_PRECONDITION (index
  // still building) falls back to equality-only limit(300) + in-memory sort
  // and adds a warning per affected section.
  const [profileSnap, orders, payments, notifications] = await Promise.all([
    settle(() => adminDb.collection('users').doc(u.uid).get(), 'profile', warnings),
    settle(() => newestByCreatedAt(adminDb, 'orders', u.uid, 50, warnings), 'orders', warnings),
    settle(() => newestByCreatedAt(adminDb, 'payments', u.uid, 20, warnings), 'payments', warnings),
    settle(() => newestByCreatedAt(adminDb, 'notifications', u.uid, 30, warnings), 'notifications', warnings),
  ]);
  console.log(`[dashboard] queries took ${Date.now() - t1}ms uid=${u.uid}`);

  // Defensive slices (the query limits above already bound the reads; settle
  // returns null when a section failed entirely).
  const ordersAll = (orders || []).slice(0, 50);

  // CUT DASHBOARD READS: status history is NO LONGER attached here (it cost
  // one batched orderStatusHistory query per page load). The UI loads history
  // lazily through GET /api/orders/track only when an order is expanded.
  const p = profileSnap?.data?.() || {};
  return res.json({
    profile: {
      displayName: p.displayName ?? '',
      email: p.email ?? u.email ?? '',
      phoneNumber: p.phoneNumber ?? '',
      deliveryDetails: p.deliveryDetails ?? null,
      // Mirror of the Auth claim maintained by /api/auth/verify/* and
      // sync-profile. Drives the "Verify your email to place orders" banner.
      emailVerified: p.emailVerified === true || u.email_verified === true,
    },
    orders: ordersAll.map(o => ({ ...o, statusHistory: undefined })),
    payments,
    notifications,
    warnings,
  });
}

export async function notifications(req, res) {
  const u = await requireUser(req);
  if (req.method === 'GET') {
    const warnings = [];
    // Newest-first via the notifications customerId+createdAt DESC composite
    // index; FAILED_PRECONDITION falls back to equality-only limit(300) +
    // in-memory sort with a warning (same helper as the dashboard).
    const list = await settle(
      () => newestByCreatedAt(adminDb, 'notifications', u.uid, 100, warnings),
      'notifications/list',
      warnings,
    );
    return res.json((list || []).slice(0, 50));
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
