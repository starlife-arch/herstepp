// Deterministic, testable account-intent handling for Aria. Never trust the
// language model to establish identity, order ownership, payment status or invoice eligibility.
export function detectAriaAccountIntent(message) {
  const text = String(message || '').toLowerCase().replace(/[^a-z0-9\s-]/g, ' ').replace(/\s+/g, ' ').trim();
  if (/\b(verify|verification|verified|verification code|resend.*code|send.*code)\b/.test(text) && /\b(email|account|verification|verify|code)\b/.test(text)) return 'verification';
  if (/\b(invoice|invoices|download.*invoice|my invoice)\b/.test(text)) return 'invoice';
  if (/\b(my payment|payment status|did .*payment|has .*payment|payment go through|mpesa status|m-pesa status|my receipt|payment receipt)\b/.test(text)) return 'payment';
  if (/\b(my orders?|order status|track my order|track order|where is my order|where's my order|order number)\b/.test(text) || /\bHS-\d{4}-\d{6}\b/i.test(text)) return 'order';
  return null;
}

const iso = value => value?.toDate ? value.toDate().toISOString() : value || null;
const statusText = value => String(value || 'UNKNOWN').replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
const money = value => 'KSh ' + (Number(value) || 0).toLocaleString('en-KE');

export async function resolveAriaAccountIntent({ db, user, message, sendVerification }) {
  const intent = detectAriaAccountIntent(message);
  if (!intent) return null;
  if (!user?.uid) {
    return { intent, reply: 'I can help with that securely. Please sign in to your HerStep account first, then ask me again so I can show only your own order and payment details.', actions: [] };
  }

  if (intent === 'verification') {
    if (user.email_verified === true) return { intent, reply: 'Your email is already verified. You’re all set!', actions: [] };
    try {
      const result = await sendVerification(user);
      if (result?.verified) return { intent, reply: 'Your email is already verified. You’re all set!', actions: [] };
      return { intent, reply: result?.sent
        ? 'I’ve requested a fresh verification code for ' + (result.maskedEmail || 'your account email') + '. Check your inbox and spam folder. The code expires in 10 minutes; you can request another after the cooldown.'
        : 'I couldn’t request a verification code just now. Please open your account verification page or contact HerStep Support for help.', actions: [] };
    } catch (error) {
      const status = Number(error?.statusCode || error?.status || 0);
      const messageText = String(error?.message || '');
      if (status === 429 || /wait before requesting|too many codes/i.test(messageText)) {
        return { intent, reply: messageText || 'Please wait a little before requesting another verification code.', actions: [] };
      }
      if (status === 503 || /not configured/i.test(messageText)) {
        return { intent, reply: 'Email verification is temporarily unavailable. Please try again later or contact HerStep Support.', actions: [] };
      }
      throw error;
    }
  }

  const query = db.collection('orders').where('customerId', '==', user.uid).orderBy('createdAt', 'desc').limit(30);
  const snapshot = await query.get();
  const orders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data(), createdAt: iso(doc.data().createdAt) }));
  const input = String(message || '');
  const number = input.match(/\bHS-\d{4}-\d{6}\b/i)?.[0]?.toUpperCase();
  const selected = number ? orders.filter(order => String(order.orderId || '').toUpperCase() === number) : orders;
  if (number && selected.length === 0) {
    return { intent, reply: 'I couldn’t find that order on your account. Please check the order number, or ask me to show your recent orders.', actions: [] };
  }
  if (!orders.length) return { intent, reply: 'I couldn’t find any orders linked to your account yet. If you checked out as a guest, please contact HerStep Support and we’ll help you locate it.', actions: [] };

  if (intent === 'invoice') {
    const eligible = [];
    for (const order of (number ? selected : orders)) {
      if (String(order.paymentStatus || '').toUpperCase() !== 'PAID' || !order.paymentId) continue;
      const paymentSnap = await db.collection('payments').doc(String(order.paymentId)).get();
      if (paymentSnap.exists && String(paymentSnap.data()?.status || '').toUpperCase() === 'PAID') {
        eligible.push({ order, invoiceNumber: order.invoiceNumber || String(order.orderId || '').replace(/^HS-/, 'INV-') });
      }
    }
    if (!eligible.length) return { intent, reply: 'Invoices are available after payment is confirmed. I couldn’t find a confirmed paid order with an available invoice on your account. You can ask me about your payment status or recent orders.', actions: [] };
    return {
      intent,
      reply: 'I found ' + eligible.length + ' paid order' + (eligible.length === 1 ? '' : 's') + ' with an available invoice. Select one below to download it.',
      actions: eligible.slice(0, 5).map(({ order, invoiceNumber }) => ({
        type: 'invoice', orderDocumentId: order.id, invoiceNumber,
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
