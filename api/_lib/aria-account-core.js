// Deterministic, testable account-intent handling for Aria. Never trust the
// language model to establish identity, order ownership, payment status or invoice eligibility.
export function detectAriaAccountIntent(message) {
  const text = String(message || '').toLowerCase().replace(/[^a-z0-9@._\\s-]/g, ' ').replace(/\\s+/g, ' ').trim();
  if (/\\b(password|reset password|forgot password|forgot my password|change password)\\b/.test(text)) return null;
  if (/\\b(verify|verification|verified|verification code|resend.*code|send.*code|confirm.*code|codes?|otp|one time password)\\b/.test(text) || /\\b(email|account)\\b.*\\b(confirm|verify|verified|code)\\b/.test(text) || /^(verify|verification|code|codes|otp|email verification)$/.test(text)) return 'verification';
  if (/\\b(invoice|invoices|bill|bills|download.*invoice|my invoice|send.*invoice|email.*invoice)\\b/.test(text) || /^invoices?$/.test(text)) return 'invoice';
  if (/\\b(payment|payments|paid|pay|mpesa|m-pesa|transaction|charged|money deducted|money taken|money sent|refund|receipt)\\b/.test(text)) return 'payment';
  if (/\\b(order|orders|delivery|deliveries|tracking|track|parcel|package|purchase|shipment|shipping)\\b/.test(text) || /\\bHS-\\d{4}-\\d{6}\\b/i.test(text)) return 'order';
  return null;
}

const iso = value => value?.toDate ? value.toDate().toISOString() : value instanceof Date ? value.toISOString() : value || null;
const statusText = value => String(value || 'UNKNOWN').replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
const money = value => 'KSh ' + (Number(value) || 0).toLocaleString('en-KE');

export async function resolveAriaAccountIntent({ db, user, message, sendVerification, confirmVerification, sendInvoice, conversationState = {} }) {
  const intent = detectAriaAccountIntent(message);
  if (!intent) return null;
  const topic = String(message || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (/^(help with )?orders?$/.test(topic)) return { intent, reply: 'Of course! What would you like help with for your orders — tracking an order, checking delivery, viewing order details, or something else?', actions: [] };
  if (/^(help with )?payments?$/.test(topic)) return { intent, reply: 'I can help with payments. Would you like to check whether a payment went through, view a receipt, or troubleshoot a pending M-Pesa payment?', actions: [] };
  if (/^(help with )?(verification|verify|codes?|email verification)$/.test(topic)) return { intent, reply: 'I can help verify your email. Would you like me to send a verification code, or have you already received a code and want me to confirm it?', actions: [] };
  if (/^(help with )?invoices?$/.test(topic)) return { intent, reply: 'Would you like to download an invoice here, or have me email an invoice to an address you choose?', actions: [] };
  if (!user?.uid) {
    return { intent, reply: 'I can help with that securely. Please sign in to your HerStep account first, then ask me again so I can show only your own order and payment details.', actions: [] };
  }

  if (intent === 'verification') {
    if (user.email_verified === true && conversationState.pendingAccountAction !== 'verify_email') return { intent, reply: 'Your email is already verified. You’re all set!', actions: [] };
    const code = String(message || '').trim();
    if (conversationState.pendingAccountAction === 'verify_email' && /^\\d{6}$/.test(code)) {
      if (typeof confirmVerification !== 'function') return { intent, reply: 'I’m ready to check your code, but verification is temporarily unavailable. Please try again shortly.', actions: [] };
      try {
        const result = await confirmVerification(user, code);
        return result?.verified
          ? { intent, reply: 'Perfect — your code is correct, and your email is now verified. You’re all set!', actions: [], clearPendingAction: true }
          : { intent, reply: 'I couldn’t confirm that code. Please check the six digits and send them here again.', actions: [], keepPendingAction: true };
      } catch (error) {
        const messageText = String(error?.message || '');
        if (/expired/i.test(messageText)) return { intent, reply: 'That code has expired. Would you like me to send a fresh one?', actions: [], clearPendingAction: true };
        if (/incorrect|attempts left|invalid/i.test(messageText)) return { intent, reply: 'That code doesn’t match. Please check the six digits and send them here again.', actions: [], keepPendingAction: true };
        return { intent, reply: 'I couldn’t verify that code just now. Please try again or contact HerStep Support.', actions: [], keepPendingAction: true };
      }
    }
    const alreadyHasCode = /\\b(already|received|got|have)\\b.{0,45}\\b(code|otp|verification)\\b|\\b(confirm|check|verify)\\b.{0,45}\\b(code|otp)\\b/i.test(message);
    if (alreadyHasCode) return { intent, reply: 'No problem — please type the six-digit code you received here in our chat. I’ll check it for you; there’s no need to request another one.', actions: [], nextAction: 'verify_email' };
    if (user.email_verified === true) return { intent, reply: 'Your email is already verified. You’re all set!', actions: [] };
    try {
      const result = await sendVerification(user);
      if (result?.verified) return { intent, reply: 'Your email is already verified. You’re all set!', actions: [], clearPendingAction: true };
      return result?.sent
        ? { intent, reply: 'I’ve sent a six-digit verification code to ' + (result.maskedEmail || 'your account email') + '. Please enter the code here in our chat, and I’ll verify it for you. It expires in 10 minutes.', actions: [], nextAction: 'verify_email' }
        : { intent, reply: 'I couldn’t send a verification code just now. Please try again later or contact HerStep Support.', actions: [] };
    } catch (error) {
      const messageText = String(error?.message || '');
      if (/wait before requesting/i.test(messageText)) return { intent, reply: messageText + ' If you already have the code, enter it here while you wait.', actions: [], nextAction: 'verify_email' };
      if (/too many codes/i.test(messageText)) return { intent, reply: messageText + ' If you already received a code, enter it here and I’ll check it for you.', actions: [], nextAction: 'verify_email' };
      if (/not configured/i.test(messageText)) return { intent, reply: 'Email verification is temporarily unavailable. Please try again later or contact HerStep Support.', actions: [] };
      throw error;
    }
  }

  const query = db.collection('orders').where('customerId', '==', user.uid).orderBy('createdAt', 'desc').limit(30);
  const snapshot = await query.get();
  const orders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data(), createdAt: iso(doc.data().createdAt) }));
  const input = String(message || '');
  const number = input.match(/\bHS-\d{4}-\d{6}\b/i)?.[0]?.toUpperCase();
  const selected = number ? orders.filter(order => String(order.orderId || '').toUpperCase() === number) : orders;
  if ((number || invoiceRef) && selected.length === 0) {
    return { intent, reply: 'I couldn’t find that order on your account. Please check the order number, or ask me to show your recent orders.', actions: [] };
  }
  if (!orders.length) return { intent, reply: 'I couldn’t find any orders linked to your account yet. If you checked out as a guest, please contact HerStep Support and we’ll help you locate it.', actions: [] };

  if (intent === 'invoice') {
    const recipient = input.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || '';
    const eligible = [];
    for (const order of (number ? selected : orders)) {
      if (String(order.paymentStatus || '').toUpperCase() !== 'PAID' || !order.paymentId) continue;
      const paymentSnap = await db.collection('payments').doc(String(order.paymentId)).get();
      if (paymentSnap.exists && String(paymentSnap.data()?.status || '').toUpperCase() === 'PAID') {
        eligible.push({ order, invoiceNumber: order.invoiceNumber || String(order.orderId || '').replace(/^HS-/, 'INV-') });
      }
    }
    if (!eligible.length) return { intent, reply: 'Invoices are available after payment is confirmed. I couldn’t find a confirmed paid order with an available invoice on your account. You can ask me about your payment status or recent orders.', actions: [] };
    if (recipient && typeof sendInvoice === 'function' && (eligible.length === 1 || number || invoiceRef)) {
      const target = eligible[0];
      const result = await sendInvoice({ uid: user.uid, orderDocumentId: target.order.id, email: recipient });
      return { intent, reply: result?.sent ? `I’ve sent invoice ${target.invoiceNumber} to ${recipient}. Please check your inbox and spam folder.` : `I queued invoice ${target.invoiceNumber} for ${recipient}, but email delivery could not be confirmed. Please try again later or contact HerStep Support.`, actions: [] };
    }
    return {
      intent,
      reply: 'I found ' + eligible.length + ' paid order' + (eligible.length === 1 ? '' : 's') + ' with an available invoice. You can download an invoice below, or tell me “send invoice to name@example.com” and I’ll email it to that address.',
      actions: eligible.slice(0, 5).map(({ order, invoiceNumber }) => ({
        type: 'invoice', orderDocumentId: order.id, invoiceNumber,
        orderId: order.orderId || '',
        label: 'Download invoice ' + invoiceNumber,
      })),
    };
  }

  const list = (number ? selected : orders).slice(0, 5);
  if (intent === 'payment') {
    return {
      intent,
      reply: list.map(order => {
        const paid = String(order.paymentStatus || '').toUpperCase();
        return (order.orderId || 'Your order') + ': payment ' + statusText(paid) + ' · Total ' + money(order.total) + (order.receiptNumber ? ' · Receipt ' + order.receiptNumber : '') + '.';
      }).join('\n') + '\nI use the payment status recorded by HerStep’s payment system; a pending M-Pesa request may take a moment to reconcile.',
      actions: [],
    };
  }
  return {
    intent,
    reply: 'Here are your recent order updates:\n' + list.map(order =>
      (order.orderId || 'Order') + ' — ' + statusText(order.orderStatus) + ' · Payment ' + statusText(order.paymentStatus) + ' · ' + money(order.total) + (order.createdAt ? ' · ' + String(order.createdAt).slice(0, 10) : '')
    ).join('\n'),
    actions: [],
  };
}
