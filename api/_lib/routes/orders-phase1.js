// Order routes shared by customers and admins (dispatched from api/orders.js
// and api/admin.js). Admin status changes delegate to adminOrderTransitionCore
// in api/_lib/order-core.js so that cancelling an unpaid order restores the
// reserved stock (NEW inventory arrays + inventoryLogs) inside ONE
// transaction — never via dotted paths.
import { FieldValue } from 'firebase-admin/firestore';
import { waitUntil } from '@vercel/functions';
import { adminDb, requireAdmin, requireUser } from '../firebase-admin.js';
import { clientError, methodNotAllowed } from '../http.js';
import { ALLOWED_ORDER_TRANSITIONS, adminOrderTransitionCore, expireStaleOrders, reconcileBestEffort } from '../order-core.js';
import { deliverEmailAfterCommit } from '../notify.js';
import { retryPendingEmails } from '../email-service.js';
import { retryPendingSms } from '../sms-service.js';

const iso = v => (v?.toDate ? v.toDate().toISOString() : v || null);
const rows = s => s.docs.map(d => ({ id: d.id, ...d.data(), createdAt: iso(d.data().createdAt), updatedAt: iso(d.data().updatedAt) }));

const ORDER_NUMBER_RE = /^HS-\d{4}-\d{6}$/i;
const RECEIPT_RE = /^HSP-[A-Z0-9]+$/i;

// Accept ANY of: ?orderId=HS-YYYY-NNNNNN | ?order=<same> | ?orderDocumentId=<doc id>
// | ?receipt=HSP-... (resolved through payments.receiptNumber). Owner only.
export async function track(req, res) {
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
  const u = await requireUser(req);
  const qv = k => (Array.isArray(req.query[k]) ? req.query[k][0] : req.query[k]);
  const rawDocId = qv('orderDocumentId');
  const numberInput = String(qv('orderId') || qv('order') || '').trim();
  const receiptInput = String(qv('receipt') || '').trim();

  let docSnap = null;
  // 1) Direct document id (internal use only — never shown to a user).
  if (typeof rawDocId === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(rawDocId)) {
    const direct = await adminDb.collection('orders').doc(rawDocId).get();
    if (direct.exists) docSnap = direct;
  }
  // 2) Human order number HS-YYYY-NNNNNN.
  if (!docSnap && ORDER_NUMBER_RE.test(numberInput)) {
    const byNumber = await adminDb.collection('orders').where('orderId', '==', numberInput.toUpperCase()).limit(1).get();
    if (!byNumber.empty) docSnap = byNumber.docs[0];
  }
  // 3) Free-form input from the tracking page: could be a number, a receipt,
  //    or a document id typed by mistake — try each in turn.
  if (!docSnap && numberInput) {
    if (RECEIPT_RE.test(numberInput)) {
      const pay = await adminDb.collection('payments').where('receiptNumber', '==', numberInput.toUpperCase()).limit(1).get();
      if (!pay.empty) {
        const pid = pay.docs[0].data().orderDocumentId;
        if (typeof pid === 'string' && pid) {
          const s = await adminDb.collection('orders').doc(pid).get();
          if (s.exists) docSnap = s;
        }
      }
    } else if (/^[A-Za-z0-9_-]{8,80}$/.test(numberInput)) {
      const direct = await adminDb.collection('orders').doc(numberInput).get();
      if (direct.exists) docSnap = direct;
    }
  }
  // 4) Explicit ?receipt=HSP-...
  if (!docSnap && RECEIPT_RE.test(receiptInput)) {
    const pay = await adminDb.collection('payments').where('receiptNumber', '==', receiptInput.toUpperCase()).limit(1).get();
    if (!pay.empty) {
      const pid = pay.docs[0].data().orderDocumentId;
      if (typeof pid === 'string' && pid) {
        const s = await adminDb.collection('orders').doc(pid).get();
        if (s.exists) docSnap = s;
      }
    }
  }
  if (!docSnap) throw clientError('We couldn\'t find that order on your account', 404);
  const d = docSnap.data();
  // Owner only — and we report "not found" rather than leaking existence.
  if (d.customerId !== u.uid) throw clientError('We couldn\'t find that order on your account', 404);

  // Best-effort reconcile for THIS customer so a lost webhook shows the real
  // payment result here too (never throws, capped by the shared rules).
  await reconcileBestEffort(adminDb, { customerId: u.uid });

  let historyRows = [];
  try {
    const h = await adminDb.collection('orderStatusHistory').where('orderDocumentId', '==', docSnap.id).get();
    historyRows = h.docs
      .map(x => ({ ...x.data(), createdAt: iso(x.data().createdAt) }))
      .sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')));
  } catch (err) {
    console.error(`[track] history lookup failed for ${docSnap.id}: ${err?.message || err}`);
  }

  // Receipt number: prefer the payment stored on the order, then look up by
  // the order's human id. Only ever surfaces for a PAID payment.
  let receiptNumber = d.receiptNumber ?? null;
  if (!receiptNumber) {
    try {
      const payQ = await adminDb.collection('payments').where('orderId', '==', d.orderId).orderBy('createdAt', 'desc').limit(5).get();
      for (const p of payQ.docs) {
        const pd = p.data();
        if (pd.status === 'PAID' && typeof pd.receiptNumber === 'string' && pd.receiptNumber) {
          receiptNumber = pd.receiptNumber;
          break;
        }
      }
    } catch (err) {
      console.error(`[track] payments lookup failed for ${d.orderId}: ${err?.message || err}`);
    }
  }

  const orderItems = Array.isArray(d.items) ? d.items : [];
  const sellerIds = [...new Set(orderItems
    .map(item => String(item?.sellerId || item?.sellerSnapshot?.sellerId || '').trim())
    .filter(Boolean))];
  const sellerProfiles = await Promise.all(sellerIds.map(async sellerId => {
    const [sellerSnap, applicationSnap] = await Promise.all([
      adminDb.collection('sellers').doc(sellerId).get(),
      adminDb.collection('sellerApplications').doc(sellerId).get(),
    ]);
    const seller = sellerSnap.exists ? sellerSnap.data() || {} : {};
    const application = applicationSnap.exists ? applicationSnap.data() || {} : {};
    const expiry = seller.subscriptionExpiresAt?.toDate?.()
      || (seller.subscriptionExpiresAt ? new Date(seller.subscriptionExpiresAt) : null);
    const activeSeller = seller.status === 'ACTIVE' && seller.billingStatus === 'ACTIVE'
      && Boolean(expiry && Number.isFinite(expiry.getTime()) && expiry.getTime() > Date.now());
    return [sellerId, {
      displayName: String(seller.displayName || application.displayName || '').slice(0, 60),
      businessName: String(seller.businessName || application.businessName || '').slice(0, 100),
      verificationBadgeActive: activeSeller && seller.verificationBadge === true,
    }];
  }));
  const sellersById = new Map(sellerProfiles);

  return res.json({
    order: {
      id: docSnap.id,
      orderId: d.orderId,
      orderStatus: d.orderStatus,
      paymentStatus: d.paymentStatus,
      sellerFulfilment: d.sellerFulfilment || {},
      firstPartyFulfilment: d.firstPartyFulfilment || null,
      // Invoice number exists as soon as the payment is PAID (set in the same
      // transaction). Derive defensively for legacy paid orders.
      invoiceNumber: d.invoiceNumber
        || (String(d.paymentStatus).toUpperCase() === 'PAID' && typeof d.orderId === 'string'
          ? d.orderId.replace(/^HS-/, 'INV-')
          : null),
      // Names everywhere — never a uid. Legacy docs without a stored name
      // fall back to the delivery name on the order itself.
      customerName: d.customerName || d.delivery?.fullName || '',
      receiptNumber,
      subtotal: Number(d.subtotal) || 0,
      deliveryFee: Number(d.deliveryFee) || 0,
      discount: Number(d.discount) || 0,
      total: Number(d.total) || 0,
      currency: d.currency || 'KES',
      createdAt: iso(d.createdAt),
      delivery: {
        fullName: d.delivery?.fullName ?? '',
        phone: d.delivery?.phone ?? '',
        deliveryMethod: d.delivery?.deliveryMethod ?? 'COLLECTION',
        location: d.delivery?.location ?? '',
        instructions: d.delivery?.notes ?? d.delivery?.instructions ?? '',
      },
      items: orderItems.map(item => {
        const sellerId = String(item?.sellerId || item?.sellerSnapshot?.sellerId || '').trim();
        const seller = sellersById.get(sellerId);
        return {
          productId: item.productId, name: item.name, size: item.size, quantity: item.quantity,
          unitPrice: item.unitPrice, lineTotal: item.lineTotal, imageUrl: item.imageUrl ?? null,
          sellerId: sellerId || null,
          sellerBusinessName: seller?.businessName || item.sellerSnapshot?.businessName || seller?.displayName || item.sellerSnapshot?.displayName || '',
          sellerVerificationBadgeActive: seller?.verificationBadgeActive === true,
        };
      }),
      history: historyRows,
    },
  });
}

export async function adminOrders(req, res) {
  const a = await requireAdmin(req);
  if (req.method === 'GET') {
    // Housekeeping first: stale unpaid orders leave the list as CANCELLED and
    // their reserved stock is restored (best-effort, never throws). Then
    // reconcile ALL customers' dead PENDING payments (limit 20, newest first)
    // so the admin badges show the truth within seconds of a lost webhook —
    // no cron needed. Best effort: never blocks or fails this GET.
    await expireStaleOrders(adminDb, { serverTimestamp: () => FieldValue.serverTimestamp() });
    await reconcileBestEffort(adminDb, { limit: 20 });
    // A small best-effort sweep keeps emails moving even if an earlier Vercel
    // invocation ended before Brevo replied. It is intentionally not awaited.
    waitUntil(retryPendingEmails(adminDb, { limit: 5 }));
    waitUntil(retryPendingSms(adminDb, { limit: 5 }));
    let q = adminDb.collection('orders');
    const statusFilter = Array.isArray(req.query.orderStatus) ? req.query.orderStatus[0] : req.query.orderStatus;
    if (typeof statusFilter === 'string' && statusFilter) q = q.where('orderStatus', '==', statusFilter);
    // Bounded read: 100 newest orders with a createdAt cursor for "Load more".
    const cursorRaw = Array.isArray(req.query.cursor) ? req.query.cursor[0] : req.query.cursor;
    q = q.orderBy('createdAt', 'desc').limit(100);
    if (typeof cursorRaw === 'string' && cursorRaw) {
      let cursorValue = cursorRaw;
      if (/^\d+$/.test(cursorRaw)) cursorValue = new Date(Number(cursorRaw));
      else { const parsed = new Date(cursorRaw); if (!Number.isNaN(parsed.getTime())) cursorValue = parsed; }
      q = q.startAfter(cursorValue);
    }
    const s = await q.get();
    const list = rows(s);

    // Batched lookups so each row carries receiptNumber + failureReason and a
    // full status-history timeline. Each lookup is best-effort: on failure the
    // field stays null/[] instead of emptying the whole page.
    const docIds = list.map(o => o.id);
    const paymentsByOrder = new Map();
    const historyByOrder = new Map();
    try {
      const paySnap = await adminDb.collection('payments').where('orderDocumentId', 'in', docIds.slice(0, 100)).get();
      for (const p of paySnap.docs) {
        const d = p.data();
        const key = d.orderDocumentId;
        const prev = paymentsByOrder.get(key);
        const rank = st => (st === 'PAID' ? 3 : st === 'PENDING' ? 2 : 1);
        if (!prev || rank(d.status) >= rank(prev.status)) paymentsByOrder.set(key, d);
      }
    } catch (error) { console.error('[adminOrders] payments lookup failed:', error?.message || error); }
    try {
      const histSnap = await adminDb.collection('orderStatusHistory').where('orderDocumentId', 'in', docIds.slice(0, 100)).get();
      for (const h of histSnap.docs) {
        const d = h.data();
        const key = d.orderDocumentId;
        if (!historyByOrder.has(key)) historyByOrder.set(key, []);
        historyByOrder.get(key).push({ ...d, createdAt: iso(d.createdAt) });
      }
      // Sort in memory — no orderBy → no composite index needed.
      for (const arr of historyByOrder.values()) {
        arr.sort((a, b) => String(a.createdAt ?? '').localeCompare(String(b.createdAt ?? '')));
      }
    } catch (error) { console.error('[adminOrders] history lookup failed:', error?.message || error); }

    // Webhook visibility banner for the admin Payments tab: read
    // settings/printpay (written by every mpesa/callback call). Best-effort.
    let printpay = null;
    try {
      const ppSnap = await adminDb.collection('settings').doc('printpay').get();
      if (ppSnap.exists) {
        const pd = ppSnap.data();
        printpay = {
          lastCallbackAt: pd.lastCallbackAt ?? null,
          lastCallbackStatus: pd.lastCallbackStatus ?? null,
          lastCallbackCheckoutId: pd.lastCallbackCheckoutId ?? null,
        };
      }
    } catch (error) { console.error('[adminOrders] settings/printpay lookup failed:', error?.message || error); }

    const lastRow = list[list.length - 1];
    const nextCursor = list.length === 100 && lastRow ? (lastRow.createdAt ?? null) : null;
    return res.json({
      nextCursor,
      orders: list.map(o => ({
      id: o.id,
      orderId: o.orderId ?? o.id,
      invoiceNumber: o.invoiceNumber ?? null,
      customerName: o.customerName ?? '',
      customerPhone: o.customerPhone ?? o.delivery?.phone ?? '',
      customerEmail: o.customerEmail ?? '',
      firstPartyFulfilment: o.firstPartyFulfilment || null,
       sellerFulfilment: o.sellerFulfilment || {},
      delivery: {
        fullName: o.delivery?.fullName ?? '',
        phone: o.delivery?.phone ?? '',
        deliveryMethod: o.delivery?.deliveryMethod ?? '',
        location: o.delivery?.location ?? '',
        instructions: o.delivery?.instructions ?? o.notes ?? '',
      },
      items: (Array.isArray(o.items) ? o.items : []).map(i => ({
        productId: i.productId ?? null,
        sellerId: i.sellerId || i.sellerSnapshot?.sellerId || null,
        sellerBusinessName: i.sellerSnapshot?.businessName || i.sellerSnapshot?.displayName || '',
        name: i.name ?? '',
        size: String(i.size ?? ''),
        quantity: Number(i.quantity) || 0,
        unitPrice: Number(i.unitPrice) || 0,
        lineTotal: Number(i.lineTotal) || 0,
        imageUrl: typeof i.imageUrl === 'string' ? i.imageUrl : null,
      })),
      subtotal: Number(o.subtotal) || 0,
      deliveryFee: Number(o.deliveryFee) || 0,
      discount: Number(o.discount) || 0,
      total: Number(o.total) || 0,
      currency: o.currency || 'KES',
      paymentStatus: o.paymentStatus ?? null,
      orderStatus: o.orderStatus ?? null,
      paymentReference: o.paymentReference ?? null,
      paymentId: o.paymentId ?? null,
      receiptNumber: o.receiptNumber ?? paymentsByOrder.get(o.id)?.receiptNumber ?? null,
      failureReason: paymentsByOrder.get(o.id)?.failureReason ?? null,
      // Late PAID after a released reservation with short stock -> admin must review.
      needsReview: o.needsReview === true,
      needsReviewNote: typeof o.needsReviewNote === 'string' ? o.needsReviewNote : null,
      history: historyByOrder.get(o.id) ?? [],
      createdAt: o.createdAt,
      updatedAt: o.updatedAt,
      })),
      printpay,
    });
  }
  if (req.method !== 'PATCH') return methodNotAllowed(res, ['GET', 'PATCH']);
  const { orderDocumentId, orderStatus, note } = req.body || {};
  if (typeof orderDocumentId !== 'string' || !orderDocumentId.trim() || orderDocumentId.includes('/')) {
    throw clientError('A valid order document reference is required.');
  }
  const targetOrderSnap = await adminDb.collection('orders').doc(orderDocumentId).get();
  if (targetOrderSnap.exists) {
    const targetOrder = targetOrderSnap.data() || {};
    const hasMarketplaceItems = (Array.isArray(targetOrder.items) ? targetOrder.items : [])
      .some(item => String(item?.sellerId || item?.sellerSnapshot?.sellerId || '').trim());
    const targetPaymentStatus = String(targetOrder.paymentStatus || '').toUpperCase();
    const cancellingUnpaidOrder = String(orderStatus || '').toUpperCase() === 'CANCELLED'
      && !['PAID', 'REFUNDED'].includes(targetPaymentStatus);
    if (hasMarketplaceItems && !cancellingUnpaidOrder) {
      const hasFirstPartyItems = (Array.isArray(targetOrder.items) ? targetOrder.items : [])
        .some(item => !String(item?.sellerId || item?.sellerSnapshot?.sellerId || '').trim());
      if (hasFirstPartyItems && targetPaymentStatus === 'PAID') {
        const orderRef = adminDb.collection('orders').doc(orderDocumentId);
        const requested = String(orderStatus || '').toUpperCase();
        const noteText = typeof note === 'string' ? note.trim().slice(0, 500) : '';
        await adminDb.runTransaction(async tx => {
          const snap = await tx.get(orderRef);
          if (!snap.exists) throw clientError('Order not found.', 404);
          const order = snap.data() || {};
          const current = String(order.firstPartyFulfilment?.status || 'PENDING').toUpperCase();
          if (String(order.paymentStatus || '').toUpperCase() !== 'PAID') throw clientError('Payment must be confirmed before fulfilment.', 409);
          const allowedFirstPartyStatuses = (ALLOWED_ORDER_TRANSITIONS[current] || []).filter(status => status !== 'CANCELLED');
          if (!allowedFirstPartyStatuses.includes(requested)) {
            throw clientError(`Cannot move HerStep-owned items from ${current.replace(/_/g, ' ').toLowerCase()} to ${requested.replace(/_/g, ' ').toLowerCase()}.`, 409);
          }
          const now = FieldValue.serverTimestamp();
          tx.update(orderRef, {
            firstPartyFulfilment: { status: requested, note: noteText, updatedAt: now, updatedBy: a.uid },
            updatedAt: now,
          });
          tx.set(adminDb.collection('orderStatusHistory').doc(), {
            orderId: order.orderId || orderDocumentId, orderDocumentId, customerId: order.customerId || null,
            eventType: 'FIRST_PARTY_FULFILMENT_STATUS_CHANGED', previousStatus: current, newStatus: requested,
            paymentStatus: order.paymentStatus, note: noteText, source: 'ADMIN', adminUid: a.uid, createdAt: now,
          });
          tx.set(adminDb.collection('notifications').doc(`${orderDocumentId}-FIRST_PARTY_${requested}`), {
            customerId: order.customerId, orderDocumentId, event: 'FIRST_PARTY_FULFILMENT_STATUS_CHANGED',
            title: 'HerStep item update', body: `The HerStep Collection items in your order are now ${requested.replace(/_/g, ' ').toLowerCase()}.`,
            readAt: null, createdAt: now,
          });
        });
        return res.json({ ok: true, message: 'Updated fulfilment for HerStep-owned items only. Marketplace sellers manage their own items separately.' });
      }
      throw clientError('This is a marketplace seller order. Sellers manage fulfilment from their Seller Dashboard; use marketplace admin tools for reports, disputes, moderation, and refunds.', 409);
    }
  }
  const result = await adminOrderTransitionCore(adminDb, { serverTimestamp: () => FieldValue.serverTimestamp() }, {
    actorUid: a.uid,
    orderDocumentId,
    orderStatus,
    note,
  });
  // POST-COMMIT EMAIL FLUSH: the transition queued a status email inside its
  // transaction; now actually send it (best-effort, kept alive by waitUntil —
  // without this line customers would never get "Your order is being
  // processed" emails). NEVER throws, NEVER blocks the response.
  if (result?.emailKey) waitUntil(deliverEmailAfterCommit(adminDb, result.emailKey));
  return res.json({ ok: true });
}
