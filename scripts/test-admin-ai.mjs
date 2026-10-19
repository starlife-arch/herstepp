import assert from 'node:assert/strict';
import { buildAdminFallbackAnswer, classifyAdminQuestion, summarizeAdminData } from '../api/_lib/routes/admin-ai-core.js';

assert.equal(classifyAdminQuestion('How much profit did we make?'), 'profit');
assert.equal(classifyAdminQuestion('Which stock is low?'), 'stock');
assert.equal(classifyAdminQuestion('How are M-Pesa payments?'), 'payments');
assert.equal(classifyAdminQuestion('How many support tickets are open?'), 'support');
assert.equal(classifyAdminQuestion('Summarise paid tips'), 'tips');
assert.equal(classifyAdminQuestion('How much did we spend on rent?'), 'expenses');
assert.equal(classifyAdminQuestion('Give me an overview'), 'sales');
assert.equal(classifyAdminQuestion('Show our best-selling products'), 'bestsellers');
assert.equal(classifyAdminQuestion('Summarise refunds and returns'), 'refunds');

const report = summarizeAdminData({
  now: new Date('2026-10-12T12:00:00Z'),
  orders: [
    { paymentStatus: 'PAID', orderStatus: 'DELIVERED', total: 2500, createdAt: '2026-10-12T08:00:00Z', items: [{ quantity: 2, unitCost: 700 }] },
    { paymentStatus: 'PENDING', orderStatus: 'PENDING', total: 1000, createdAt: '2026-10-11T08:00:00Z', items: [{ quantity: 1 }] },
  ],
  products: [
    { name: 'Low-stock heel', status: 'ACTIVE', inventory: [{ size: '38', quantity: 2 }, { size: '39', quantity: 0 }, { size: '40', quantity: 5 }] },
    { status: 'DRAFT', inventory: [{ quantity: 100 }] },
  ],
  tickets: [{ status: 'OPEN' }, { status: 'RESOLVED' }],
  tips: [{ status: 'PAID', amount: 300 }, { status: 'PENDING', amount: 500 }],
  expenses: [{ amount: 500, expenseDate: '2026-10-01' }, { amount: 200, expenseDate: '2026-09-20' }],
  refunds: [{ status: 'COMPLETED', amount: 350 }, { status: 'PENDING', amount: 150 }],
});

assert.equal(report.sales.paidOrderCount, 1);
assert.equal(report.sales.paidOrderValue, 2500);
assert.equal(report.sales.paidTodayValue, 2500);
assert.equal(report.sales.paidThisMonthValue, 2500);
assert.equal(report.stock.activeProducts, 1);
assert.equal(report.stock.unitsInStock, 7);
assert.equal(report.stock.lowStockVariants, 1);
assert.equal(report.stock.outOfStockVariants, 1);
assert.equal(report.stock.lowStockItems[0].name, 'Low-stock heel');
assert.equal(report.support.ticketCount, 2);
assert.equal(report.tips.paidTipCount, 1);
assert.equal(report.tips.paidTipValue, 300);
assert.equal(report.expenses.recordedValue, 700);
assert.equal(report.expenses.thisMonthValue, 500);
assert.equal(report.bestSellers[0].unitsSold, 2);
assert.equal(report.refunds.recordCount, 2);
assert.equal(report.refunds.completedCount, 1);
assert.equal(report.refunds.completedAmount, 350);
assert.match(buildAdminFallbackAnswer('refunds', report), /KSh 350/);
assert.match(buildAdminFallbackAnswer('bestsellers', report), /2 units/);
assert.match(buildAdminFallbackAnswer('expenses', report), /KSh 700/);
assert.equal(report.profit.knownGrossProfit, 1100);
assert.equal(report.profit.knownCostPaidOrderCount, 1);

const missingCosts = summarizeAdminData({
  orders: [{ paymentStatus: 'PAID', orderStatus: 'DELIVERED', total: 9999, items: [{ quantity: 1 }] }],
});
assert.equal(missingCosts.profit.knownGrossProfit, null);
assert.match(buildAdminFallbackAnswer('profit', missingCosts), /can’t calculate a reliable profit/i);

console.log('test-admin-ai: all assertions passed');
