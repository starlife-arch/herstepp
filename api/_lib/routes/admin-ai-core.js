const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const upper = value => String(value || '').trim().toUpperCase();
function asDate(value) {
  try {
    if (value?.toDate) return value.toDate();
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  } catch { return null; }
}
function nairobiDateParts(value) {
  const date = asDate(value);
  if (!date) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Nairobi', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const fields = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return { day: fields.year + '-' + fields.month + '-' + fields.day, month: fields.year + '-' + fields.month };
}

export function classifyAdminQuestion(message) {
  const text = String(message || '').toLowerCase();
  if (/\b(profit|margin|cost of goods|cost price|expenses?)\b/.test(text)) return 'profit';
  if (/\b(stock|inventory|out of stock|low stock|products?)\b/.test(text)) return 'stock';
  if (/\b(ticket|support|complaint|unresolved|customer service)\b/.test(text)) return 'support';
  if (/\b(tip|tips|tipping)\b/.test(text)) return 'tips';
  if (/\b(payment|paid|unpaid|mpesa|m-pesa|receipt|transaction)\b/.test(text)) return 'payments';
  if (/\b(order|orders|delivery|cancelled|canceled|pending)\b/.test(text)) return 'orders';
  if (/\b(sales|revenue|income|turnover|today|week|month|overview|summary|performance)\b/.test(text)) return 'sales';
  return 'overview';
}

export function summarizeAdminData({ orders = [], products = [], tickets = [], tips = [], now = new Date() } = {}) {
  const paidOrders = orders.filter(order => upper(order.paymentStatus) === 'PAID');
  const pendingOrders = orders.filter(order => ['PENDING', 'PROCESSING', ''].includes(upper(order.orderStatus)));
  const paymentPending = orders.filter(order => ['PENDING', 'PROCESSING', 'TIMEOUT'].includes(upper(order.paymentStatus)));
  const sales = paidOrders.reduce((sum, order) => sum + number(order.total), 0);
  const todayKey = nairobiDateParts(now)?.day;
  const monthKey = nairobiDateParts(now)?.month;
  const paidToday = paidOrders.filter(order => nairobiDateParts(order.createdAt)?.day === todayKey);
  const paidThisMonth = paidOrders.filter(order => nairobiDateParts(order.createdAt)?.month === monthKey);
  const statuses = {};
  for (const order of orders) {
    const status = upper(order.orderStatus) || 'UNKNOWN';
    statuses[status] = (statuses[status] || 0) + 1;
  }

  let totalStock = 0;
  let lowStockVariants = 0;
  let outOfStockVariants = 0;
  let activeProducts = 0;
  const lowStockItems = [];
  for (const product of products) {
    if (upper(product.status) !== 'ACTIVE') continue;
    activeProducts += 1;
    for (const variant of Array.isArray(product.inventory) ? product.inventory : []) {
      const quantity = Math.max(0, number(variant?.quantity));
      totalStock += quantity;
      if (quantity === 0) outOfStockVariants += 1;
      else if (quantity <= 2) lowStockVariants += 1;
      if (quantity <= 2) lowStockItems.push({ name: String(product.name || 'Unnamed product').slice(0, 120), size: String(variant?.size || ''), quantity });
    }
  }

  const paidTips = tips.filter(tip => upper(tip.status) === 'PAID');
  const tipTotal = paidTips.reduce((sum, tip) => sum + number(tip.amount), 0);
  const ticketStatuses = {};
  for (const ticket of tickets) {
    const status = upper(ticket.status) || 'UNKNOWN';
    ticketStatuses[status] = (ticketStatuses[status] || 0) + 1;
  }

  let knownCostOrders = 0;
  let knownGrossProfit = 0;
  for (const order of paidOrders) {
    const items = Array.isArray(order.items) ? order.items : [];
    if (!items.length) continue;
    let cost = 0;
    let complete = true;
    for (const item of items) {
      const unitCost = [item.unitCost, item.costPrice, item.cost].find(v => v !== undefined && v !== null && v !== '');
      if (unitCost === undefined || !Number.isFinite(Number(unitCost)) || Number(unitCost) < 0) { complete = false; break; }
      cost += number(unitCost) * Math.max(0, number(item.quantity));
    }
    if (complete) {
      knownCostOrders += 1;
      knownGrossProfit += number(order.total) - cost;
    }
  }

  return {
    sampleWindow: {
      orders: orders.length,
      note: 'Order figures are based on the newest order records fetched for this report, not a guaranteed lifetime total.',
    },
    sales: {
      paidOrderCount: paidOrders.length,
      paidOrderValue: sales,
      paidTodayCount: paidToday.length,
      paidTodayValue: paidToday.reduce((sum, order) => sum + number(order.total), 0),
      paidThisMonthCount: paidThisMonth.length,
      paidThisMonthValue: paidThisMonth.reduce((sum, order) => sum + number(order.total), 0),
      pendingPaymentCount: paymentPending.length,
      pendingOrderCount: pendingOrders.length,
      orderStatuses: statuses,
    },
    stock: { activeProducts, unitsInStock: totalStock, lowStockVariants, outOfStockVariants, lowStockItems: lowStockItems.sort((a, b) => a.quantity - b.quantity).slice(0, 30) },
    support: { ticketCount: tickets.length, statuses: ticketStatuses },
    tips: { paidTipCount: paidTips.length, paidTipValue: tipTotal },
    profit: {
      knownCostPaidOrderCount: knownCostOrders,
      paidOrderCount: paidOrders.length,
      knownGrossProfit: knownCostOrders > 0 ? knownGrossProfit : null,
      note: knownCostOrders === paidOrders.length && paidOrders.length > 0
        ? 'Gross profit is estimated only from recorded item cost fields and paid order totals; it is not net profit and excludes operating expenses.'
        : 'Reliable profit cannot be calculated unless item cost data is recorded for every paid order in the report. Do not estimate missing costs.',
    },
  };
}

export function buildAdminFallbackAnswer(intent, report) {
  const currency = amount => 'KSh ' + Math.round(number(amount)).toLocaleString('en-KE');
  if (intent === 'profit') {
    if (report.profit.knownGrossProfit === null || report.profit.knownCostPaidOrderCount !== report.profit.paidOrderCount) {
      return 'I can’t calculate a reliable profit figure yet because cost data is missing for some or all paid orders in this report. The system must record item cost prices, and net profit also requires operating expenses. I won’t guess those figures.';
    }
    return 'Recorded gross profit across the paid orders with complete cost data is ' + currency(report.profit.knownGrossProfit) + '. This is gross profit, not net profit, and excludes operating expenses. ' + report.profit.note;
  }
  if (intent === 'stock') {
    const items = (report.stock.lowStockItems || []).map(item => item.name + (item.size ? ' size ' + item.size : '') + ': ' + item.quantity + ' left').join('; ');
    return 'Stock snapshot: ' + report.stock.activeProducts + ' active products, ' + report.stock.unitsInStock + ' units in stock, ' + report.stock.lowStockVariants + ' low-stock variants (1–2 units), and ' + report.stock.outOfStockVariants + ' out-of-stock variants. Low-stock list: ' + (items || 'no low-stock variants found in the fetched active product catalogue') + '.';
  }
  if (intent === 'support') return 'Support snapshot: ' + report.support.ticketCount + ' tickets in the fetched report. Statuses: ' + (Object.entries(report.support.statuses).map(([k, v]) => k + ': ' + v).join(', ') || 'no tickets found') + '.';
  if (intent === 'tips') return 'Paid tips in the fetched report: ' + report.tips.paidTipCount + ', totalling ' + currency(report.tips.paidTipValue) + '.';
  if (intent === 'payments') return 'Payment snapshot: ' + report.sales.paidOrderCount + ' paid orders totalling ' + currency(report.sales.paidOrderValue) + '; ' + report.sales.pendingPaymentCount + ' orders have pending/processing/timed-out payment status. This uses the newest order records fetched for the report.';
  if (intent === 'orders') return 'Order snapshot: ' + report.sampleWindow.orders + ' recent orders fetched. Statuses: ' + (Object.entries(report.sales.orderStatuses).map(([k, v]) => k + ': ' + v).join(', ') || 'no orders found') + '. ' + report.sales.pendingOrderCount + ' are pending/processing orders.';
  if (intent === 'sales') return 'Sales snapshot from the newest order records fetched: ' + report.sales.paidOrderCount + ' paid orders totalling ' + currency(report.sales.paidOrderValue) + '. In that fetched sample, today (Kenya time) has ' + report.sales.paidTodayCount + ' paid orders totalling ' + currency(report.sales.paidTodayValue) + ', and this month has ' + report.sales.paidThisMonthCount + ' paid orders totalling ' + currency(report.sales.paidThisMonthValue) + '. This is not guaranteed to be a lifetime total.';
  return 'I’m your read-only Admin AI. I can summarise sales, order statuses, payment states, stock levels, support tickets, paid tips, and explain whether recorded cost data is sufficient to estimate gross profit. The report uses real records and clearly labels its sample window. Try asking “Summarise sales”, “Which stock is low?”, “How are payments?”, or “Can we calculate profit?”.';
}
