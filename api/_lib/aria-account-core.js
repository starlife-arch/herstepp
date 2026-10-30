// Deterministic, testable account-intent handling for Aria. Never trust the
// language model to establish identity, order ownership, payment status or invoice eligibility.
export function detectAriaAccountIntent(message) {
  const text = String(message || '').toLowerCase().replace(/[^a-z0-9@._\s-]/g, ' ').replace(/\s+/g, ' ').trim();
  if (/\b(password|reset password|forgot password|forgot my password|change password)\b/.test(text)) return null;
  if (/\b(verify|verification|verified|verification code|resend.*code|send.*code|confirm.*code|codes?|otp|one time password)\b/.test(text) || /\b(email|account)\b.*\b(confirm|verify|verified|code)\b/.test(text) || /^(verify|verification|code|codes|otp|email verification)$/.test(text) || /\b(?:i have|i've|ive|already)\s+(?:received|got)\s+(?:it|one|the code)\b/.test(text)) return 'verification';
  if (/\b(points?|rewards?|loyalty|redeem|redemption)\b/.test(text)) return 'rewards';
  if (/\b(promotion wallet|promotions wallet|wallet balance|promoted products|campaigns?|promotions?)\b/.test(text)) return 'promotions';
  if (/\b(seller plan|subscription|seller subscription|plan expiry|product limit|verified badge)\b/.test(text)) return 'seller_plan';
  if (/\b(seller orders?|orders? from my shop|my shop orders|my sales|seller earnings|marketplace seller)\b/.test(text)) return 'seller_orders';
  if (/\b(invoice|invoices|bill|bills|download.*invoice|my invoice|send.*invoice|email.*invoice)\b/.test(text) || /^invoices?$/.test(text)) return 'invoice';
  if (/\b(payment|payments|paid|pay|mpesa|m-pesa|transaction|charged|money (?:was )?deducted|money taken|money sent|refund|receipt)\b/.test(text)) return 'payment';
  if (/\b(order|orders|delivery|deliveries|tracking|track|parcel|package|purchase|shipment|shipping)\b/.test(text) || /\bHS-\d{4}-\d{6}\b/i.test(text)) return 'order';
  return null;
}

const iso = value => value?.toDate ? value.toDate().toISOString() : value instanceof Date ? value.toISOString() : value || null;
const statusText = value => String(value || 'UNKNOWN').replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
const money = value => 'KSh ' + (Number(value) || 0).toLocaleString('en-KE');

export async function resolveAriaAccountIntent({ db, user, message, sendVerification, confirmVerification, sendInvoice, conversationState = {} }) {
  const detectedIntent = detectAriaAccountIntent(message);
  const intent = detectedIntent || (conversationState.pendingAccountAction === 'verify_email' && /^\d{6}$/.test(String(message || '').trim()) ? 'verification' : null);
  if (!intent) return null;
  const topic = String(message || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  if (/^(help with )?orders?$/.test(topic)) return { intent, reply: 'Of course! What would you like help with for your orders — tracking an order, checking delivery, viewing order details, or something else?', actions: [] };
  if (/^(points?|rewards?|loyalty)$/.test(topic)) return { intent, reply: 'I can check your live rewards balance, recent points activity, expiry and eligible ways to redeem. Would you like your balance or your rewards history?', actions: [] };
  if (/^(promotions?|promotion wallet|wallet)$/.test(topic)) return { intent, reply: 'I can check your seller promotion wallet, campaigns and promoted products if you have an active seller account. What would you like to check?', actions: [] };
  if (/^(plans?|seller plan|subscription)$/.test(topic)) return { intent, reply: 'I can check your seller plan, product limit, billing status and renewal date. Would you like your current plan details?', actions: [] };
  if (/^(seller orders?|my sales)$/.test(topic)) return { intent, reply: 'I can check orders containing your own seller products and their fulfilment status. Would you like your latest seller orders?', actions: [] };
  if (/^(help with )?payments?$/.test(topic)) return { intent, reply: 'I can help with payments. Would you like to check whether a payment went through, view a receipt, or troubleshoot a pending M-Pesa payment?', actions: [] };
  if (/^(help with )?(verification|verify|codes?|email verification)$/.test(topic)) return { intent, reply: 'I can help verify your email. Would you like me to send a verification code, or have you already received a code and want me to confirm it?', actions: [] };
  if (/^(help with )?invoices?$/.test(topic)) return { intent, reply: 'Would you like to download an invoice here, or have me email an invoice to an address you choose?', actions: [] };
  if (!user?.uid) {
    return { intent, reply: 'I can help with that securely. Please sign in to your HerStep account first, then ask me again so I can show only your own order and payment details.', actions: [] };
  }

  if (intent === 'verification') {
    if (user.email_verified === true && conversationState.pendingAccountAction !== 'verify_email') return { intent, reply: 'Your email is already verified. You’re all set!', actions: [] };
    const code = String(message || '').trim();
    if (conversationState.pendingAccountAction === 'verify_email' && /^\d{6}$/.test(code)) {
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
    const alreadyHasCode = /\b(already|received|got|have)\b.{0,45}\b(code|otp|verification)\b|\b(confirm|check|verify)\b.{0,45}\b(code|otp)\b|\b(?:i have|i've|ive|already)\s+(?:received|got)\s+(?:it|one|the code)\b/i.test(message);
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

  const now = Date.now();
  if (intent === 'rewards') {
    const [configSnap, accountSnap, ledgerSnap, sellerSnap] = await Promise.all([
      db.collection('rewardsConfig').doc('current').get(),
      db.collection('rewardAccounts').doc(user.uid).get(),
      db.collection('rewardLedger').where('uid', '==', user.uid).get(),
      db.collection('sellers').doc(user.uid).get(),
    ]);
    const config = configSnap.data() || {};
    const entries = ledgerSnap.docs.map(doc => {
      const e = doc.data() || {};
      const expiry = e.expiresAt?.toMillis?.() ?? e.expiresAt?.toDate?.()?.getTime?.() ?? (e.expiresAt instanceof Date ? e.expiresAt.getTime() : null);
      return { type: String(e.type || 'UNKNOWN'), points: Number(e.points) || 0, status: String(e.status || 'POSTED').toUpperCase(), expired: Number(e.points) > 0 && expiry != null && expiry <= now, createdAt: iso(e.createdAt), reason: String(e.reason || '') };
    }).sort((a,b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    const balance = Math.max(0, entries.reduce((sum,e) => sum + (e.status === 'POSTED' && !e.expired ? e.points : 0), 0));
    const seller = sellerSnap.exists && ['ACTIVE','PENDING'].includes(String(sellerSnap.data()?.status || '').toUpperCase());
    const enabled = config.enabled === true;
    const redemption = enabled && (seller ? config.seller?.redemptionEnabled === true : config.buyer?.redemptionEnabled === true);
    const value = Number(config.pointValueKes) || 0;
    const recent = entries.slice(0,5).map(e => (e.points > 0 ? '+' : '') + e.points.toLocaleString() + ' points — ' + e.type.replace(/_/g,' ').toLowerCase() + (e.expired ? ' (expired)' : '')).join('; ');
    return { intent, reply: 'I checked your live HerStep rewards ledger. Available balance: ' + balance.toLocaleString() + ' points. Estimated value: ' + money(balance * value) + '. Programme: ' + (enabled ? 'enabled' : 'currently disabled') + '. Redemption: ' + (redemption ? 'enabled for your account type' : 'not currently enabled for your account type') + (config.expiryDays ? '. Points expiry setting: ' + Number(config.expiryDays) + ' days' : '') + '. Recent activity: ' + (recent || 'no reward transactions recorded') + '. This balance is calculated from posted, non-expired ledger entries, not an unverified cached balance.', actions: [] };
  }

  if (intent === 'seller_plan' || intent === 'promotions' || intent === 'seller_orders') {
    const [sellerSnap, applicationSnap] = await Promise.all([
      db.collection('sellers').doc(user.uid).get(),
      db.collection('sellerApplications').doc(user.uid).get(),
    ]);
    const seller = sellerSnap.data() || {};
    if (!sellerSnap.exists) {
      const application = applicationSnap.data() || {};
      return { intent, reply: applicationSnap.exists ? 'I checked your live seller application. Its current status is ' + statusText(application.status) + (application.adminReason ? '. Note: ' + String(application.adminReason).slice(0,250) : '') + '. You do not yet have an active seller account, so seller plans, promotion wallet and seller orders are not available.' : 'I checked your account and could not find a seller profile or seller application. You can apply to become a HerStep marketplace seller from the Sell on HerStep page.', actions: [] };
    }
    if (intent === 'seller_plan') {
      const [subscriptionSnap, pricingSnap] = await Promise.all([
        db.collection('sellerSubscriptions').where('sellerId','==',user.uid).limit(20).get(),
        db.collection('sellerSubscriptionPricing').doc('current').get(),
      ]);
      const expiry = seller.subscriptionExpiresAt?.toDate?.() || (seller.subscriptionExpiresAt ? new Date(seller.subscriptionExpiresAt) : null);
      const active = String(seller.billingStatus || '').toUpperCase() === 'ACTIVE' && expiry && expiry.getTime() > now;
      const plan = String(seller.planCode || 'STARTER').toUpperCase();
      const limits = { STARTER:20, STANDARD:100, GROWTH:1000, UNLIMITED:null };
      const planPrices = { STARTER:150, STANDARD:350, GROWTH:800, UNLIMITED:1500 };
      const recent = subscriptionSnap.docs.map(d => d.data() || {}).sort((a,b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0];
      const discounts = pricingSnap.data()?.termDiscounts || {1:0,3:5,6:10,12:20};
      return { intent, reply: 'Your live seller plan: ' + plan + '. Plan billing: ' + statusText(seller.billingStatus) + (active ? ' (currently active)' : ' (not currently active or expired)') + '. Product limit: ' + (limits[plan] == null ? 'unlimited' : limits[plan]) + '. Base monthly plan price: ' + money(planPrices[plan] || 0) + '. Subscription expiry: ' + (expiry && Number.isFinite(expiry.getTime()) ? expiry.toLocaleDateString('en-KE') : 'not recorded') + '. Verified-business badge: ' + (seller.verificationBadge === true ? 'active' : 'not active') + '. Latest recorded subscription: ' + (recent ? statusText(recent.status) + ' · ' + String(recent.planCode || plan) + ' · ' + money(recent.amount) : 'no subscription payment record found') + '. Current term discounts: ' + Object.entries(discounts).map(([months,pct]) => months + ' months: ' + pct + '%').join(', ') + '.', actions: [] };
    }
    if (String(seller.status || '').toUpperCase() !== 'ACTIVE') return { intent, reply: 'Your seller account status is ' + statusText(seller.status) + '. Seller promotion wallet and seller order tools require an active approved seller account.', actions: [] };
    if (intent === 'promotions') {
      const [walletSnap, ledgerSnap, campaignSnap, productsSnap] = await Promise.all([
        db.collection('sellerPromotionWallets').doc(user.uid).get(),
        db.collection('sellerPromotionWalletLedger').where('sellerUid','==',user.uid).limit(100).get(),
        db.collection('sellerPromotionCampaigns').where('sellerUid','==',user.uid).limit(100).get(),
        db.collection('products').where('sellerUid','==',user.uid).limit(500).get(),
      ]);
      const wallet = walletSnap.data() || {};
      const campaigns = campaignSnap.docs.map(d => d.data() || {});
      const activeCampaigns = campaigns.filter(x => { const until=x.promotedUntil?.toDate?.() || (x.promotedUntil ? new Date(x.promotedUntil) : null); return String(x.status || '').toUpperCase()==='ACTIVE' && until && until.getTime()>now; });
      const promoted = productsSnap.docs.filter(d => { const x=d.data()||{}; const until=x.promotedUntil?.toDate?.() || (x.promotedUntil ? new Date(x.promotedUntil) : null); return String(x.status||'').toUpperCase()==='ACTIVE' && until && until.getTime()>now; }).length;
      const ledger = ledgerSnap.docs.map(d=>d.data()||{});
      return { intent, reply: 'Your live seller promotion wallet: available balance ' + money(wallet.availableBalance) + ', total top-ups ' + money(wallet.totalDeposited) + ', total spent ' + money(wallet.totalSpent) + '. Active campaigns: ' + activeCampaigns.length + '. Active promoted products: ' + promoted + '. Campaign history records: ' + campaigns.length + '. Recent wallet entries: ' + (ledger.slice(0,5).map(x=>String(x.type||'ENTRY').replace(/_/g,' ').toLowerCase()+' '+money(Math.abs(Number(x.balanceDelta)||0))).join('; ') || 'none') + '. Promotions are separate from seller sales earnings.', actions: [] };
    }
    const [ledgerSnap, recentOrdersSnap] = await Promise.all([
      db.collection('sellerLedger').where('sellerId','==',user.uid).limit(1000).get(),
      db.collection('orders').orderBy('createdAt','desc').limit(500).get(),
    ]);
    const orderIds = new Set(ledgerSnap.docs.map(d=>String(d.data()?.orderDocumentId||'').trim()).filter(Boolean));
    const docs = new Map(recentOrdersSnap.docs.map(d=>[d.id,d]));
    const older = await Promise.all([...orderIds].filter(id=>!docs.has(id)).slice(0,500).map(id=>db.collection('orders').doc(id).get()));
    older.filter(d=>d.exists).forEach(d=>docs.set(d.id,d));
    const sellerOrders = [...docs.values()].map(doc=>{
      const order=doc.data()||{};
      const items=(Array.isArray(order.items)?order.items:[]).filter(item=>String(item?.sellerId||item?.sellerSnapshot?.sellerId||'')===user.uid);
      if(!items.length || String(order.paymentStatus||'').toUpperCase()!=='PAID') return null;
      const fulfillment=order.sellerFulfilment?.[user.uid]||{};
      return { orderId:order.orderId||doc.id, status:statusText(fulfillment.status||'PENDING'), total:items.reduce((sum,item)=>sum+(Number(item.lineTotal??item.total)||Number(item.unitPrice||0)*Number(item.quantity||0)),0), createdAt:iso(order.createdAt), itemCount:items.length };
    }).filter(Boolean).sort((a,b)=>String(b.createdAt||'').localeCompare(String(a.createdAt||'')));
    return { intent, reply: 'Your live seller order summary: ' + sellerOrders.length + ' paid orders found in the available seller order records. Latest orders: ' + (sellerOrders.slice(0,5).map(o=>o.orderId+' — '+o.status+' — '+money(o.total)+' — '+o.itemCount+' item lines').join('; ') || 'none found') + '. I only counted product lines assigned to your seller account.', actions: [] };
  }

  const query = db.collection('orders').where('customerId', '==', user.uid).orderBy('createdAt', 'desc').limit(30);
  const snapshot = await query.get();
  const orders = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data(), createdAt: iso(doc.data().createdAt) }));
  const input = String(message || '');
  const number = input.match(/\bHS-\d{4}-\d{6}\b/i)?.[0]?.toUpperCase();
  const invoiceRef = input.match(/\bINV-\d{4}-\d{6}\b/i)?.[0]?.toUpperCase();
  const selected = number ? orders.filter(order => String(order.orderId || '').toUpperCase() === number) : invoiceRef ? orders.filter(order => String(order.invoiceNumber || '').toUpperCase() === invoiceRef || String(order.orderId || '').replace(/^HS-/i, 'INV-').toUpperCase() === invoiceRef) : orders;
  if ((number || invoiceRef) && selected.length === 0) {
    return { intent, reply: 'I couldn’t find that order on your account. Please check the order number, or ask me to show your recent orders.', actions: [] };
  }
  if (!orders.length) return { intent, reply: 'I couldn’t find any orders linked to your account yet. If you checked out as a guest, please contact HerStep Support and we’ll help you locate it.', actions: [] };

  if (intent === 'invoice') {
    const recipient = input.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0] || '';
    const eligible = [];
    for (const order of ((number || invoiceRef) ? selected : orders)) {
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

  const orderCountQuestion = intent === 'order' && /\b(?:how many|number of|count of|total number|total count)\b.{0,45}\b(?:orders?|purchases?)\b|\b(?:orders?|purchases?)\b.{0,35}\b(?:how many|count|total|number)\b/i.test(input);
  if (orderCountQuestion && !number && !invoiceRef) {
    let total = orders.length;
    let exact = false;
    try {
      const countSnap = await db.collection('orders').where('customerId', '==', user.uid).count().get();
      const countValue = Number(countSnap.data()?.count);
      if (Number.isFinite(countValue)) { total = countValue; exact = true; }
    } catch (error) {
      console.error('[Aria account] order count aggregation unavailable:', error?.message || error);
    }
    return {
      intent,
      reply: exact
        ? 'I checked your HerStep account records: you have ' + total + ' order' + (total === 1 ? '' : 's') + ' in total. That includes all orders linked to your signed-in account, not just the five recent orders shown in chat.'
        : 'I could retrieve ' + orders.length + ' recent order records for your account, but I couldn’t verify the all-time total just now. I don’t want to guess; please try again shortly.',
      actions: [],
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
