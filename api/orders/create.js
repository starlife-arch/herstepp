/**
 * HerStep Collection — Order Creation API
 * 
 * POST /api/orders/create
 * 
 * Creates an order with server-side validation:
 * - Verifies products exist and are active
 * - Validates selected sizes exist
 * - Checks stock availability
 * - Validates prices (never trusts client-side prices)
 * - Validates discounts/promo codes
 * - Atomically decreases inventory
 * - Prevents race conditions with Firestore transactions
 */

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  try {
    const { items, customerId, customerName, customerPhone, customerEmail,
            deliveryMethod, deliveryLocation, deliveryInstructions, promoCode } = req.body;

    // ──────────────────────────────────────────
    // VALIDATION
    // ──────────────────────────────────────────
    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ success: false, message: 'Cart is empty' });
    }

    if (!customerId || !customerName || !customerPhone || !customerEmail) {
      return res.status(400).json({ success: false, message: 'Missing customer information' });
    }

    if (!deliveryMethod || !['collection', 'delivery'].includes(deliveryMethod)) {
      return res.status(400).json({ success: false, message: 'Invalid delivery method' });
    }

    if (deliveryMethod === 'delivery' && !deliveryLocation) {
      return res.status(400).json({ success: false, message: 'Delivery location required' });
    }

    const admin = getFirebaseAdmin();
    const db = admin.firestore();

    // ──────────────────────────────────────────
    // ATOMIC ORDER CREATION
    // ──────────────────────────────────────────
    const result = await db.runTransaction(async (transaction) => {
      let subtotal = 0;
      const validatedItems = [];

      // ──────────────────────────────────────────
      // VALIDATE EACH ITEM
      // ──────────────────────────────────────────
      for (const item of items) {
        const { productId, size, quantity } = item;

        if (!productId || !size || !quantity || quantity < 1) {
          throw new Error('Invalid item data');
        }

        // Fetch product from database
        const productRef = db.collection('products').doc(productId);
        const productDoc = await transaction.get(productRef);

        if (!productDoc.exists) {
          throw new Error(`Product not found: ${productId}`);
        }

        const product = productDoc.data();

        // Verify product is active
        if (product.status !== 'active') {
          throw new Error(`Product is not available: ${product.name}`);
        }

        // Verify size exists
        const sizeData = product.sizes?.find(s => s.size === parseInt(size));
        if (!sizeData) {
          throw new Error(`Size ${size} not available for ${product.name}`);
        }

        // Verify stock
        if (sizeData.quantity < quantity) {
          throw new Error(`Insufficient stock for ${product.name} size ${size}. Only ${sizeData.quantity} available.`);
        }

        // Use SERVER-SIDE price (never trust client)
        const unitPrice = product.salePrice || product.price;
        const itemTotal = unitPrice * quantity;
        subtotal += itemTotal;

        validatedItems.push({
          productId: productId,
          productName: product.name,
          productImage: product.images[0],
          size: parseInt(size),
          quantity: parseInt(quantity),
          unitPrice: unitPrice,
          total: itemTotal,
        });

        // Decrease inventory atomically
        const updatedSizes = product.sizes.map(s => {
          if (s.size === parseInt(size)) {
            return { ...s, quantity: s.quantity - quantity };
          }
          return s;
        });

        transaction.update(productRef, {
          sizes: updatedSizes,
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        // Log inventory change
        const inventoryLogRef = db.collection('inventoryLogs').doc();
        transaction.set(inventoryLogRef, {
          productId,
          productName: product.name,
          size: parseInt(size),
          previousQuantity: sizeData.quantity,
          newQuantity: sizeData.quantity - quantity,
          change: -quantity,
          reason: 'order_placed',
          orderId: null, // Will be updated after order creation
          timestamp: admin.firestore.FieldValue.serverTimestamp(),
        });
      }

      // ──────────────────────────────────────────
      // VALIDATE PROMO CODE
      // ──────────────────────────────────────────
      let discount = 0;
      let appliedPromo = null;

      if (promoCode) {
        const promoQuery = await db.collection('promoCodes')
          .where('code', '==', promoCode.toUpperCase())
          .where('active', '==', true)
          .limit(1)
          .get();

        if (!promoQuery.empty) {
          const promo = promoQuery.docs[0].data();
          const now = new Date();

          // Check expiry
          if (new Date(promo.endDate) < now) {
            throw new Error('Promo code has expired');
          }

          // Check minimum order
          if (promo.minOrder && subtotal < promo.minOrder) {
            throw new Error(`Minimum order of KSh ${promo.minOrder} required for this promo code`);
          }

          // Check usage limit
          if (promo.maxUsage && promo.currentUsage >= promo.maxUsage) {
            throw new Error('Promo code usage limit reached');
          }

          // Calculate discount
          if (promo.type === 'percentage') {
            discount = Math.round(subtotal * promo.discountValue / 100);
          } else if (promo.type === 'fixed') {
            discount = promo.discountValue;
          }

          appliedPromo = { code: promo.code, discount: discount };

          // Increment usage count
          transaction.update(promoQuery.docs[0].ref, {
            currentUsage: admin.firestore.FieldValue.increment(1),
          });
        }
      }

      // ──────────────────────────────────────────
      // CALCULATE DELIVERY FEE
      // ──────────────────────────────────────────
      let deliveryFee = 0;
      if (deliveryMethod === 'delivery') {
        // Fetch delivery settings
        const settingsDoc = await transaction.get(db.collection('settings').doc('delivery'));
        if (settingsDoc.exists) {
          const settings = settingsDoc.data();
          deliveryFee = settings.defaultFee || 150;
        } else {
          deliveryFee = 150; // Default fallback
        }
      }

      const total = subtotal - discount + deliveryFee;

      // ──────────────────────────────────────────
      // GENERATE ORDER ID
      // ──────────────────────────────────────────
      // Format: HS-YYYY-NNNNNN
      const year = new Date().getFullYear();
      const counterDoc = await transaction.get(db.collection('settings').doc('orderCounter'));
      let counter = 1;
      if (counterDoc.exists) {
        counter = (counterDoc.data().current || 0) + 1;
      }
      const orderId = `HS-${year}-${String(counter).padStart(6, '0')}`;

      // Update counter
      transaction.set(db.collection('settings').doc('orderCounter'), {
        current: counter,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      }, { merge: true });

      // ──────────────────────────────────────────
      // CREATE ORDER
      // ──────────────────────────────────────────
      const orderId_internal = `order_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
      const orderRef = db.collection('orders').doc(orderId_internal);

      const orderData = {
        id: orderId_internal,
        orderId: orderId,
        customerId,
        customerName,
        customerPhone,
        customerEmail,
        items: validatedItems,
        subtotal,
        deliveryFee,
        discount,
        total,
        deliveryMethod,
        deliveryLocation: deliveryMethod === 'collection' ? 'Jerry House, near Juja Posta' : deliveryLocation,
        deliveryInstructions: deliveryInstructions || null,
        promoCode: appliedPromo?.code || null,
        paymentStatus: 'pending',
        orderStatus: 'pending',
        statusHistory: [{
          previousStatus: 'pending',
          newStatus: 'pending',
          timestamp: new Date().toISOString(),
          note: 'Order placed',
        }],
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      };

      transaction.set(orderRef, orderData);

      // Create notification
      const notifRef = db.collection('notifications').doc();
      transaction.set(notifRef, {
        userId: customerId,
        title: 'Order Placed',
        message: `Your order ${orderId} has been placed successfully. Total: KSh ${total}. Please complete payment.`,
        type: 'order',
        read: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        link: `/track?orderId=${orderId}`,
      });

      return { orderId: orderId, orderIdInternal: orderId_internal, total };
    });

    // ──────────────────────────────────────────
    // RESPONSE
    // ──────────────────────────────────────────
    return res.status(201).json({
      success: true,
      message: 'Order created successfully',
      orderId: result.orderId,
      orderIdInternal: result.orderIdInternal,
      total: result.total,
    });

  } catch (error) {
    console.error('Order creation error:', error);
    return res.status(400).json({
      success: false,
      message: error.message || 'Order creation failed'
    });
  }
}

let adminInstance;
function getFirebaseAdmin() {
  if (!adminInstance) {
    const admin = require('firebase-admin');
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert({
          projectId: process.env.FIREBASE_ADMIN_PROJECT_ID,
          clientEmail: process.env.FIREBASE_ADMIN_CLIENT_EMAIL,
          privateKey: process.env.FIREBASE_ADMIN_PRIVATE_KEY?.replace(/\\n/g, '\n'),
        }),
      });
    }
    adminInstance = admin;
  }
  return adminInstance;
}
