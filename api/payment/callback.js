/**
 * HerStep Collection — Payment Callback API
 * 
 * This endpoint receives M-Pesa payment confirmations from the payment provider.
 * 
 * POST /api/payment/callback
 * 
 * IMPORTANT:
 * - This is the SOURCE OF TRUTH for payment status
 * - Never mark a payment as successful from the frontend
 * - Callbacks must be IDEMPOTENT (handle duplicates safely)
 * - Validates callback signature/authenticity
 * - Uses Firestore transactions to prevent race conditions
 */

export default async function handler(req, res) {
  // Only accept POST requests
  if (req.method !== 'POST') {
    return res.status(405).json({ ResultCode: 1, ResultDesc: 'Method not allowed' });
  }

  try {
    // ──────────────────────────────────────────
    // VALIDATE CALLBACK AUTHENTICITY
    // ──────────────────────────────────────────
    // Verify the callback is from your payment provider
    // Implementation depends on your provider

    const callbackSecret = req.headers['x-callback-secret'] || req.headers['authorization'];
    if (callbackSecret !== process.env.PAYMENT_CALLBACK_SECRET) {
      console.error('Invalid callback signature');
      return res.status(401).json({ ResultCode: 1, ResultDesc: 'Unauthorized' });
    }

    // ──────────────────────────────────────────
    // PARSE CALLBACK DATA
    // ──────────────────────────────────────────
    const callbackData = req.body;

    // Safaricom Daraja API callback format:
    // {
    //   Body: {
    //     stkCallback: {
    //       MerchantRequestID: string,
    //       CheckoutRequestID: string,
    //       ResultCode: number,  // 0 = success
    //       ResultDesc: string,
    //       CallbackMetadata: {
    //         Item: [
    //           { Name: "Amount", Value: number },
    //           { Name: "MpesaReceiptNumber", Value: string },
    //           { Name: "TransactionDate", Value: number },
    //           { Name: "PhoneNumber", Value: number },
    //         ]
    //       }
    //     }
    //   }
    // }

    // Extract data based on provider format
    const {
      merchantRequestId,
      checkoutRequestId,
      resultCode,
      resultDesc,
      amount,
      mpesaReceipt,
      transactionDate,
      phoneNumber,
    } = extractCallbackData(callbackData);

    console.log('Payment callback received:', {
      checkoutRequestId,
      resultCode,
      mpesaReceipt,
      amount,
    });

    // ──────────────────────────────────────────
    // FIND PAYMENT RECORD
    // ──────────────────────────────────────────
    const admin = getFirebaseAdmin();
    const db = admin.firestore();

    // Find payment by checkout request ID
    const paymentQuery = await db.collection('payments')
      .where('providerRef', '==', checkoutRequestId)
      .limit(1)
      .get();

    if (paymentQuery.empty) {
      // Try finding by merchant request ID
      const altQuery = await db.collection('payments')
        .where('providerRef', '==', merchantRequestId)
        .limit(1)
        .get();

      if (altQuery.empty) {
        console.error('Payment not found for callback:', checkoutRequestId);
        return res.status(404).json({ ResultCode: 1, ResultDesc: 'Payment not found' });
      }
    }

    const paymentDoc = paymentQuery.empty
      ? (await db.collection('payments').where('providerRef', '==', merchantRequestId).limit(1).get()).docs[0]
      : paymentQuery.docs[0];

    const payment = paymentDoc.data();
    const paymentId = paymentDoc.id;

    // ──────────────────────────────────────────
    // IDEMPOTENCY CHECK
    // ──────────────────────────────────────────
    // If payment is already processed, don't process again
    if (payment.status === 'paid' || payment.status === 'failed') {
      console.log('Payment already processed:', paymentId, payment.status);
      return res.status(200).json({ ResultCode: 0, ResultDesc: 'Already processed' });
    }

    // ──────────────────────────────────────────
    // DETERMINE PAYMENT STATUS
    // ──────────────────────────────────────────
    let newStatus;
    let failureReason;

    if (resultCode === 0) {
      // Success
      newStatus = 'paid';
    } else if (resultCode === 1032 || resultCode === 1037) {
      // Cancelled by user or timeout
      newStatus = 'cancelled';
      failureReason = resultDesc;
    } else if (resultCode === 1031) {
      // Unable to lock subscriber (user busy)
      newStatus = 'failed';
      failureReason = 'Customer phone was busy. Please try again.';
    } else {
      // Other failure
      newStatus = 'failed';
      failureReason = resultDesc;
    }

    // ──────────────────────────────────────────
    // UPDATE PAYMENT AND ORDER (ATOMIC)
    // ──────────────────────────────────────────
    // Use Firestore transaction for consistency
    await db.runTransaction(async (transaction) => {
      const paymentRef = db.collection('payments').doc(paymentId);
      const orderRef = db.collection('orders').doc(payment.orderId);

      // Re-read payment to ensure it hasn't changed
      const freshPaymentDoc = await transaction.get(paymentRef);
      const freshPayment = freshPaymentDoc.data();

      // Double-check idempotency
      if (freshPayment.status === 'paid' || freshPayment.status === 'failed') {
        return; // Already processed
      }

      // Update payment record
      transaction.update(paymentRef, {
        status: newStatus,
        transactionRef: mpesaReceipt || null,
        failureReason: failureReason || null,
        callbackData: callbackData,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // Update order payment status
      transaction.update(orderRef, {
        paymentStatus: newStatus,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // If payment successful, add to order status history
      if (newStatus === 'paid') {
        const orderDoc = await transaction.get(orderRef);
        const order = orderDoc.data();
        const history = order.statusHistory || [];
        history.push({
          previousStatus: order.orderStatus,
          newStatus: order.orderStatus, // Keep same order status
          timestamp: new Date().toISOString(),
          note: 'Payment received via M-Pesa',
        });
        transaction.update(orderRef, { statusHistory: history });
      }

      // Create notification for customer
      const notificationRef = db.collection('notifications').doc();
      transaction.set(notificationRef, {
        userId: payment.customerId,
        title: newStatus === 'paid' ? 'Payment Received' : 'Payment Failed',
        message: newStatus === 'paid'
          ? `Payment of KSh ${payment.amount} for order ${payment.orderId} has been received.`
          : `Payment for order ${payment.orderId} failed. ${failureReason || 'Please try again.'}`,
        type: 'payment',
        read: false,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        link: `/track?orderId=${payment.orderId}`,
      });

      // If payment successful and order is pending, move to processing
      if (newStatus === 'paid') {
        const orderDoc = await transaction.get(orderRef);
        const order = orderDoc.data();
        if (order.orderStatus === 'pending') {
          transaction.update(orderRef, {
            orderStatus: 'processing',
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          });
        }
      }
    });

    // ──────────────────────────────────────────
    // RESPONSE
    // ──────────────────────────────────────────
    console.log(`Payment ${paymentId} updated to status: ${newStatus}`);

    return res.status(200).json({
      ResultCode: 0,
      ResultDesc: 'Payment processed successfully',
    });

  } catch (error) {
    console.error('Payment callback error:', error);
    // Still return success to prevent provider from retrying
    // The error is logged for investigation
    return res.status(200).json({
      ResultCode: 0,
      ResultDesc: 'Callback received',
    });
  }
}

/**
 * Extract callback data based on provider format
 * Adjust this function for your specific payment provider
 */
function extractCallbackData(data) {
  // Safaricom Daraja API format
  if (data.Body && data.Body.stkCallback) {
    const callback = data.Body.stkCallback;
    const metadata = callback.CallbackMetadata?.Item || [];

    const getItem = (name) => metadata.find(i => i.Name === name)?.Value;

    return {
      merchantRequestId: callback.MerchantRequestID,
      checkoutRequestId: callback.CheckoutRequestID,
      resultCode: callback.ResultCode,
      resultDesc: callback.ResultDesc,
      amount: getItem('Amount'),
      mpesaReceipt: getItem('MpesaReceiptNumber'),
      transactionDate: getItem('TransactionDate'),
      phoneNumber: getItem('PhoneNumber')?.toString(),
    };
  }

  // Generic provider format (adjust for your provider)
  return {
    merchantRequestId: data.merchant_request_id || data.MerchantRequestID,
    checkoutRequestId: data.checkout_request_id || data.CheckoutRequestID,
    resultCode: data.result_code || data.ResultCode,
    resultDesc: data.result_desc || data.ResultDesc,
    amount: data.amount || data.Amount,
    mpesaReceipt: data.receipt_number || data.MpesaReceiptNumber,
    transactionDate: data.transaction_date || data.TransactionDate,
    phoneNumber: data.phone_number || data.PhoneNumber,
  };
}

/**
 * Get Firebase Admin instance
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
