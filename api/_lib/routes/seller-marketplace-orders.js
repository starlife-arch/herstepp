import { FieldValue } from 'firebase-admin/firestore';
import { adminDb, requireUser } from '../firebase-admin.js';
import { clientError, methodNotAllowed } from '../http.js';

const clean = (value, max = 500) => typeof value === 'string' ? value.trim().slice(0, max) : '';
const iso = value => value?.toDate?.().toISOString?.() ?? (typeof value === 'string' ? value : null);
const sellerIdFor = item => String(item?.sellerId || item?.sellerSnapshot?.sellerId || '').trim();
const transitions = {
  PENDING: ['PROCESSING'],
  PROCESSING: ['PROCESSED'],
  PROCESSED: ['OUT_FOR_DELIVERY'],
  OUT_FOR_DELIVERY: ['DELIVERED'],
  DELIVERED: [],
  CANCELLED: [],
};
const nextStatus = value => String(value || 'PENDING').toUpperCase();
const base64url = value => Buffer.from(value).toString('base64url');

function serializeOrder(doc, uid) {
  const order = doc.data() || {};
  const items = (Array.isArray(order.items) ? order.items : []).filter(item => sellerIdFor(item) === uid);
  if (!items.length) return null;
  const fulfillment = order.sellerFulfilment?.[uid] || {};
  return {
    id: doc.id,
    orderDocumentId: doc.id,
    orderId: order.orderId || doc.id,
    status: nextStatus(fulfillment.status),
    statusUpdatedAt: iso(fulfillment.updatedAt),
    statusNote: fulfillment.note || '',
    paymentStatus: String(order.paymentStatus || '').toUpperCase(),
    paidAt: iso(order.paymentCompletedAt || order.paidAt),
    createdAt: iso(order.createdAt),
    buyer: {
      name: String(order.delivery?.fullName || order.customerName || 'Buyer').slice(0, 120),
      email: String(order.customerEmail || order.email || '').slice(0, 254),
      phone: String(order.delivery?.phone || order.customerPhone || order.phone || '').slice(0, 40),
      deliveryMethod: String(order.delivery?.deliveryMethod || order.deliveryMethod || 'DELIVERY').toUpperCase(),
      location: String(order.delivery?.location || order.deliveryLocation || '').slice(0, 250),
      instructions: String(order.delivery?.instructions || order.deliveryInstructions || '').slice(0, 500),
    },
    items: items.map(item => ({
      productId: item.productId || '',
      name: String(item.name || item.productName || 'Marketplace item').slice(0, 160),
      imageUrl: String(item.imageUrl || item.productImage || ''),
      size: String(item.size ?? ''),
      quantity: Number(item.quantity) || 0,
      unitPrice: Number(item.unitPrice) || 0,
      lineTotal: Number(item.lineTotal ?? item.total) || (Number(item.unitPrice) || 0) * (Number(item.quantity) || 0),
    })),
    sellerTotal: items.reduce((sum, item) => sum + (Number(item.lineTotal ?? item.total) || (Number(item.unitPrice) || 0) * (Number(item.quantity) || 0)), 0),
  };
}

export default async function sellerMarketplaceOrders(req, res) {
  const user = await requireUser(req);
  const sellerRef = adminDb.collection('sellers').doc(user.uid);
  const sellerSnap = await sellerRef.get();
  if (!sellerSnap.exists || sellerSnap.data()?.ownerUid !== user.uid) {
    throw clientError('An approved seller account is required to manage marketplace orders.', 403);
  }

  if (req.method === 'GET') {
    // Discover orders through this seller's own ledger, not a global latest-250
    // query that can silently hide older seller sales.
    const ledgerSnap = await adminDb.collection('sellerLedger').where('sellerId', '==', user.uid).limit(2000).get();
    const orderIds = [...new Set(ledgerSnap.docs
      .map(doc => String(doc.data()?.orderDocumentId || '').trim())
      .filter(id => /^[A-Za-z0-9_-]{8,150}$/.test(id)))];
    const snapshots = await Promise.all(orderIds.map(id => adminDb.collection('orders').doc(id).get()));
    const orders = snapshots.filter(doc => doc.exists)
      .map(doc => serializeOrder(doc, user.uid))
      .filter(order => order && order.paymentStatus === 'PAID')
      .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    return res.status(200).json({ orders });
  }
  if (req.method !== 'PATCH') return methodNotAllowed(res, ['GET', 'PATCH']);

  const orderDocumentId = clean(req.body?.orderDocumentId, 150);
  const requestedStatus = clean(req.body?.status, 40).toUpperCase();
  const note = clean(req.body?.note, 500);
  if (!/^[A-Za-z0-9_-]{8,150}$/.test(orderDocumentId)) throw clientError('A valid order reference is required.');
  if (!Object.hasOwn(transitions, requestedStatus)) throw clientError('Choose a valid seller fulfilment status.');

  const orderRef = adminDb.collection('orders').doc(orderDocumentId);
  const sellerLedgerQuery = adminDb.collection('sellerLedger').where('sellerId', '==', user.uid);
  const result = await adminDb.runTransaction(async tx => {
    const [orderSnap, ledgerSnap] = await Promise.all([tx.get(orderRef), tx.get(sellerLedgerQuery)]);
    if (!orderSnap.exists) throw clientError('Order not found.', 404);
    const order = orderSnap.data() || {};
    if (String(order.paymentStatus || '').toUpperCase() !== 'PAID') throw clientError('Only confirmed paid orders can be fulfilled.', 409);
    const ownItems = (Array.isArray(order.items) ? order.items : []).filter(item => sellerIdFor(item) === user.uid);
    if (!ownItems.length) throw clientError('This order does not contain products belonging to your seller account.', 403);

    const previous = nextStatus(order.sellerFulfilment?.[user.uid]?.status);
    if (!(transitions[previous] || []).includes(requestedStatus)) {
      throw clientError(`Cannot move your fulfilment from ${previous.replace(/_/g, ' ').toLowerCase()} to ${requestedStatus.replace(/_/g, ' ').toLowerCase()}.`, 409);
    }

    let releaseWrites = [];
    if (requestedStatus === 'DELIVERED') {
      const ledgerRows = ledgerSnap.docs.map(doc => ({ id: doc.id, data: doc.data() || {} }))
        .filter(row => row.data.orderDocumentId === orderDocumentId);
      const gross = ledgerRows.filter(row => row.data.type === 'ORDER_PAYMENT_PENDING')
        .reduce((sum, row) => sum + Math.max(0, Number(row.data.amount) || 0), 0);
      // Release NET pending earnings. Refund reconciliation can reduce pending
      // before delivery; releasing gross here would over-credit the seller.
      const amount = Math.max(0, ledgerRows
        .filter(row => String(row.data.balanceBucket || '').toUpperCase() === 'PENDING')
        .reduce((sum, row) => sum + (Number(row.data.amount) || 0), 0));
      if (gross <= 0) throw clientError('Seller earnings for this order were not found. Contact marketplace support before marking it delivered.', 409);
      if (amount > 0) {
        const base = base64url(`marketplace-delivery-release:${orderDocumentId}:${user.uid}`);
        releaseWrites = [
          { id: base + '_pending', amount: -amount, balanceBucket: 'PENDING', type: 'MARKETPLACE_EARNINGS_RELEASE_PENDING' },
          { id: base + '_available', amount, balanceBucket: 'AVAILABLE', type: 'MARKETPLACE_EARNINGS_RELEASE_AVAILABLE' },
        ];
        const existing = await tx.getAll(...releaseWrites.map(row => adminDb.collection('sellerLedger').doc(row.id)));
        if (existing.some(snap => snap.exists)) throw clientError('Earnings release entries already exist. Contact marketplace support before retrying.', 409);
      }
    }

    const now = FieldValue.serverTimestamp();
    const sellerFulfilment = {
      ...(order.sellerFulfilment && typeof order.sellerFulfilment === 'object' ? order.sellerFulfilment : {}),
      [user.uid]: { status: requestedStatus, note, updatedAt: now, updatedBy: user.uid },
    };
    tx.update(orderRef, { sellerFulfilment, updatedAt: now });
    tx.set(adminDb.collection('sellerOrderStatusHistory').doc(), {
      orderDocumentId, orderId: order.orderId || orderDocumentId, sellerUid: user.uid,
      previousStatus: previous, newStatus: requestedStatus, note, actorUid: user.uid, createdAt: now,
    });
    tx.set(adminDb.collection('sellerMarketplaceAudit').doc(), {
      action: 'SELLER_ORDER_FULFILMENT_UPDATED', sellerUid: user.uid,
      orderDocumentId, orderId: order.orderId || orderDocumentId,
      previousStatus: previous, newStatus: requestedStatus, actorUid: user.uid, createdAt: now,
    });
    for (const row of releaseWrites) {
      tx.create(adminDb.collection('sellerLedger').doc(row.id), {
        sellerId: user.uid, orderDocumentId, orderId: order.orderId || orderDocumentId,
        type: row.type, status: 'POSTED', amount: row.amount, currency: order.currency || 'KES',
        balanceBucket: row.balanceBucket, idempotencyKey: row.id, createdAt: now,
      });
    }
    return { previous, status: requestedStatus, released: requestedStatus === 'DELIVERED' ? releaseWrites.find(row => row.balanceBucket === 'AVAILABLE')?.amount || 0 : 0 };
  });
  return res.status(200).json({
    success: true, ...result,
    message: result.status === 'DELIVERED'
      ? 'Delivery recorded. Eligible seller earnings have moved from pending to available, subject to refund holds.'
      : 'Your marketplace fulfilment status has been updated.',
  });
}
