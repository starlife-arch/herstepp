/**
 * HerStep Collection — Payment Initiation API
 * 
 * This endpoint triggers an M-Pesa STK Push to the customer's phone.
 * 
 * POST /api/payment/initiate
 * 
 * Request body:
 * {
 *   orderId: string,
 *   phoneNumber: string,
 *   amount: number
 * }
 * 
 * Response:
 * {
 *   success: boolean,
 *   message: string,
 *   checkoutRequestId?: string
 * }
 * 
 * IMPORTANT:
 * - This function runs server-side on Vercel
 * - Payment credentials are NEVER exposed to the client
 * - Amount is validated server-side against the order total
 * - Uses Firebase Admin SDK for privileged database access
 */

export default async function handler(req, res) {
  // Only accept POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, message: 'Method not allowed' });
  }

  try {
    const { orderId, phoneNumber, amount } = req.body;

    // ──────────────────────────────────────────
    // VALIDATION
    // ──────────────────────────────────────────
    if (!orderId || !phoneNumber || !amount) {
      return res.status(400).json({
        success: false,
        message: 'Missing required fields: orderId, phoneNumber, amount'
      });
    }

    // Validate phone number format (Kenyan)
    const cleanPhone = phoneNumber.replace(/\s/g, '');
    if (!/^(\+254|0)[17]\d{8}$/.test(cleanPhone)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid phone number format'
      });
    }

    // Normalize phone to international format
    const formattedPhone = cleanPhone.startsWith('0')
      ? '+254' + cleanPhone.slice(1)
      : cleanPhone;

    // ──────────────────────────────────────────
    // SERVER-SIDE ORDER VALIDATION
    // ──────────────────────────────────────────
    // IMPORTANT: Never trust client-side amounts
    // Fetch the order from Firestore and verify the total
    const admin = getFirebaseAdmin();
    const db = admin.firestore();

    const orderRef = db.collection('orders').doc(orderId);
    const orderDoc = await orderRef.get();

    if (!orderDoc.exists) {
      return res.status(404).json({
        success: false,
        message: 'Order not found'
      });
    }

    const order = orderDoc.data();

    // Verify amount matches order total
    if (Math.abs(order.total - amount) > 1) {
      return res.status(400).json({
        success: false,
        message: 'Amount mismatch. Please refresh and try again.'
      });
    }

    // Verify order is in payable state
    if (order.paymentStatus === 'paid') {
      return res.status(400).json({
        success: false,
        message: 'This order has already been paid'
      });
    }

    if (order.orderStatus === 'cancelled') {
      return res.status(400).json({
        success: false,
        message: 'This order has been cancelled'
      });
    }

    // ──────────────────────────────────────────
    // CHECK FOR DUPLICATE PENDING PAYMENT
    // ──────────────────────────────────────────
    const existingPayment = await db.collection('payments')
      .where('orderId', '==', orderId)
      .where('status', '==', 'pending')
      .limit(1)
      .get();

    if (!existingPayment.empty) {
      return res.status(400).json({
        success: false,
        message: 'A payment is already in progress for this order. Please wait.'
      });
    }

    // ──────────────────────────────────────────
    // CREATE PAYMENT RECORD
    // ──────────────────────────────────────────
    const paymentId = `pay_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    const paymentRef = db.collection('payments').doc(paymentId);

    await paymentRef.set({
      id: paymentId,
      orderId: orderId,
      customerId: order.customerId,
      amount: amount,
      phone: formattedPhone,
      method: 'mpesa_stk_push',
      status: 'pending',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // ──────────────────────────────────────────
    // INITIATE STK PUSH
    // ──────────────────────────────────────────
    // Replace this section with your actual M-Pesa API provider integration
    // The implementation depends on your chosen provider (Daraja, IntaSend, etc.)

    const stkResponse = await initiateSTKPush({
      phoneNumber: formattedPhone,
      amount: amount,
      accountReference: orderId,
      transactionDesc: `HerStep Collection - Order ${orderId}`,
      callbackUrl: process.env.PAYMENT_CALLBACK_URL,
    });

    // Update payment with provider reference
    await paymentRef.update({
      providerRef: stkResponse.checkoutRequestId || stkResponse.MerchantRequestID,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    });

    // ──────────────────────────────────────────
    // RESPONSE
    // ──────────────────────────────────────────
    return res.status(200).json({
      success: true,
      message: 'STK Push sent successfully. Please check your phone.',
      checkoutRequestId: stkResponse.checkoutRequestId,
      paymentId: paymentId,
    });

  } catch (error) {
    console.error('Payment initiation error:', error);
    return res.status(500).json({
      success: false,
      message: 'Payment initiation failed. Please try again.'
    });
  }
}

/**
 * Initiates M-Pesa STK Push
 * 
 * REPLACE THIS FUNCTION with your actual payment provider's API call.
 * 
 * Example for Safaricom Daraja API:
 */
async function initiateSTKPush({ phoneNumber, amount, accountReference, transactionDesc, callbackUrl }) {
  // ──────────────────────────────────────────
  // SAFARICOM DARAJA API IMPLEMENTATION
  // ──────────────────────────────────────────
  // Uncomment and configure for direct Daraja integration:

  /*
  const consumerKey = process.env.MPESA_CONSUMER_KEY;
  const consumerSecret = process.env.MPESA_CONSUMER_SECRET;
  const shortcode = process.env.MPESA_SHORTCODE;
  const passkey = process.env.MPESA_PASSKEY;
  
  // Get OAuth token
  const auth = Buffer.from(`${consumerKey}:${consumerSecret}`).toString('base64');
  const tokenResponse = await fetch(
    'https://sandbox.safaricom.co.ke/oauth/v1/generate?grant_type=client_credentials',
    { headers: { Authorization: `Basic ${auth}` } }
  );
  const { access_token } = await tokenResponse.json();
  
  // Generate timestamp
  const timestamp = new Date().toISOString().replace(/[^0-9]/g, '').slice(0, -3);
  const password = Buffer.from(`${shortcode}${passkey}${timestamp}`).toString('base64');
  
  // Make STK Push request
  const stkResponse = await fetch(
    'https://sandbox.safaricom.co.ke/mpesa/stkpush/v1/processrequest',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        BusinessShortCode: shortcode,
        Password: password,
        Timestamp: timestamp,
        TransactionType: 'CustomerPayBillOnline',
        Amount: amount,
        PartyA: phoneNumber.replace('+', ''),
        PartyB: shortcode,
        PhoneNumber: phoneNumber.replace('+', ''),
        CallBackURL: callbackUrl,
        AccountReference: accountReference,
        TransactionDesc: transactionDesc,
      }),
    }
  );
  
  return await stkResponse.json();
  */

  // ──────────────────────────────────────────
  // THIRD-PARTY PROVIDER IMPLEMENTATION
  // ──────────────────────────────────────────
  // Example for IntaSend, Pesapal, or similar:

  const providerUrl = process.env.PAYMENT_API_URL || 'https://api.paymentprovider.com/v1/stkpush';

  const response = await fetch(providerUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.PAYMENT_API_KEY}`,
    },
    body: JSON.stringify({
      phone_number: phoneNumber,
      amount: amount,
      reference: accountReference,
      description: transactionDesc,
      callback_url: callbackUrl,
    }),
  });

  if (!response.ok) {
    throw new Error(`Payment provider error: ${response.statusText}`);
  }

  const data = await response.json();

  return {
    checkoutRequestId: data.checkout_request_id || data.request_id,
    MerchantRequestID: data.merchant_request_id,
  };
}

/**
 * Get Firebase Admin instance
 * Lazily initialized to avoid cold start overhead
 */
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
