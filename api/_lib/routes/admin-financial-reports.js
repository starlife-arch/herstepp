import { adminDb, requireAdmin } from '../firebase-admin.js';
import { clientError, methodNotAllowed } from '../http.js';

const iso = value => value?.toDate ? value.toDate().toISOString() : value instanceof Date ? value.toISOString() : typeof value === 'string' ? value : null;
const amount = value => Number.isFinite(Number(value)) && Number(value) >= 0 ? Number(value) : 0;
const statusOf = row => String(row.status || row.paymentStatus || '').toUpperCase();
const paid = row => ['PAID', 'COMPLETED', 'CONFIRMED', 'SUCCEEDED'].includes(statusOf(row));
const dateOf = row => iso(row.completedAt || row.paidAt || row.createdAt || row.updatedAt);
const readRecent = async name => {
  try {
    const snap = await adminDb.collection(name).limit(1000).get();
    return snap.docs.map(doc => ({ id: doc.id, ...doc.data() }));
  } catch (error) {
    console.error('financial report collection read failed:', name, error?.message || error);
    return [];
  }
};
function within(date, from, to) {
  if (!date) return false;
  const time = new Date(date).getTime();
  return Number.isFinite(time) && time >= from.getTime() && time < to.getTime();
}
function sum(rows, key = 'amount') { return rows.reduce((total, row) => total + amount(row[key]), 0); }

export default async function adminFinancialReports(req, res) {
  await requireAdmin(req);
  if (req.method !== 'GET') return methodNotAllowed(res, 'GET');
  const period = String(req.query?.period || 'month').toLowerCase();
  if (!['day', 'month', 'year', 'custom'].includes(period)) throw clientError('Choose day, month, year, or custom period.');
  const now = new Date();
  const fromRaw = String(req.query?.from || '');
  const toRaw = String(req.query?.to || '');
  let from, to;
  if (period === 'custom') {
    from = new Date(fromRaw);
    to = new Date(toRaw);
    if (!fromRaw || !toRaw || !Number.isFinite(from.getTime()) || !Number.isFinite(to.getTime()) || to <= from) throw clientError('A valid custom date range is required.');
    to.setDate(to.getDate() + 1);
  } else {
    from = new Date(now);
    if (period === 'day') from.setHours(0, 0, 0, 0);
    if (period === 'month') { from.setDate(1); from.setHours(0, 0, 0, 0); }
    if (period === 'year') { from.setMonth(0, 1); from.setHours(0, 0, 0, 0); }
    to = new Date(now.getTime() + 1);
  }
  const [subscriptions, promotions, aiCredits, promoLedger, refunds, ordersPayments] = await Promise.all([
    readRecent('sellerSubscriptionPayments'),
    readRecent('sellerPromotionPayments'),
    readRecent('sellerBulkCreditPayments'),
    readRecent('sellerPromotionWalletLedger'),
    readRecent('refundRecords'),
    readRecent('payments'),
  ]);
  const rows = [];
  const add = (sourceRows, category, label) => {
    for (const row of sourceRows) {
      const date = dateOf(row);
      if (!paid(row) || !within(date, from, to)) continue;
      rows.push({ id: row.id, category, description: label, date, amount: amount(row.amount), currency: row.currency || 'KES', provider: row.provider || row.method || 'Not recorded', providerFee: row.providerFee ?? row.paymentProviderFee ?? row.feeAmount ?? null, reference: row.transactionReference || row.providerReference || row.paymentId || row.id });
    }
  };
  add(subscriptions, 'Seller plans', 'Seller subscription payment');
  add(promotions, 'Promotions', 'Direct promotion payment');
  add(aiCredits, 'AI tokens', 'Seller AI bulk-upload credit purchase');
  // Wallet top-ups are customer funds held as credit, not revenue. Recognize
  // revenue when the seller spends wallet funds on a promotion campaign.
  for (const row of promoLedger) {
    const type = String(row.type || '').toUpperCase();
    const date = dateOf(row);
    if (type !== 'CAMPAIGN_SPEND' || !within(date, from, to)) continue;
    rows.push({ id: row.id, category: 'Promotions', description: 'Promotion wallet campaign spend', date, amount: amount(row.amount), currency: row.currency || 'KES', provider: 'Promotion wallet', providerFee: null, reference: row.campaignId || row.id });
  }
  // Do not classify ordinary customer order gross as HerStep revenue; no
  // marketplace commission amount is assumed unless a dedicated fee field exists.
  for (const row of ordersPayments) {
    const fee = row.marketplaceFee ?? row.platformFee ?? row.commissionAmount;
    const date = dateOf(row);
    if (fee == null || !paid(row) || !within(date, from, to)) continue;
    rows.push({ id: row.id, category: 'Marketplace fees', description: 'Recorded marketplace fee', date, amount: amount(fee), currency: row.currency || 'KES', provider: row.provider || row.method || 'Not recorded', providerFee: row.providerFee ?? row.paymentProviderFee ?? null, reference: row.transactionReference || row.providerReference || row.id });
  }
  const refundRows = refunds.filter(row => String(row.status || '').toUpperCase() === 'CONFIRMED' && within(dateOf(row), from, to));
  const refundTotal = sum(refundRows);
  const revenue = sum(rows);
  const providerFeeKnown = rows.filter(row => row.providerFee !== null && row.providerFee !== undefined);
  const providerFees = sum(providerFeeKnown, 'providerFee');
  const missingProviderFeeCount = rows.length - providerFeeKnown.length;
  const byCategory = [...new Set(rows.map(row => row.category))].map(category => ({ category, total: sum(rows.filter(row => row.category === category)), count: rows.filter(row => row.category === category).length }));
  const netRevenue = revenue - refundTotal - providerFees;
  const explanation = [];
  explanation.push(`Recorded gross marketplace revenue for this period is KSh ${revenue.toLocaleString('en-KE')} across ${rows.length} qualifying records.`);
  explanation.push(`Confirmed refunds recorded in the period total KSh ${refundTotal.toLocaleString('en-KE')}.`);
  explanation.push(missingProviderFeeCount ? `Payment-provider fees are missing on ${missingProviderFeeCount} revenue records, so the net figure is provisional and excludes unrecorded fees.` : `Recorded provider fees total KSh ${providerFees.toLocaleString('en-KE')}.`);
  explanation.push(`Calculated net revenue after recorded refunds and provider fees is KSh ${netRevenue.toLocaleString('en-KE')}.`);
  return res.status(200).json({
    period, from: from.toISOString(), to: to.toISOString(), currency: 'KES',
    totals: { grossRevenue: revenue, confirmedRefunds: refundTotal, recordedProviderFees: providerFees, netRevenue, transactionCount: rows.length, refundCount: refundRows.length, providerFeeRecordedCount: providerFeeKnown.length, providerFeeMissingCount: missingProviderFeeCount },
    byCategory, transactions: rows.sort((a, b) => String(b.date).localeCompare(String(a.date))).slice(0, 500),
    refunds: refundRows.map(row => ({ id: row.id, amount: amount(row.amount), date: dateOf(row), reference: row.providerReference || row.orderId || row.id })).slice(0, 200),
    dataQuality: { sourceCollections: ['sellerSubscriptionPayments', 'sellerPromotionPayments', 'sellerBulkCreditPayments', 'sellerPromotionWalletLedger', 'refundRecords', 'payments'], perCollectionReadLimit: 1000, note: 'Only verified paid records and confirmed refunds are included. Wallet top-ups are excluded until spent; ordinary order gross is not treated as HerStep revenue. Provider fees absent from records are not estimated. Records beyond the collection read limit may not be included.' },
    aiExplanation: explanation.join(' ')
  });
}
