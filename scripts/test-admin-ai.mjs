import assert from 'node:assert/strict';
import { buildAdminFallbackAnswer, classifyAdminQuestion, summarizeAdminData } from '../api/_lib/routes/admin-ai-core.js';

assert.equal(classifyAdminQuestion('How much profit did we make?'), 'profit');
assert.equal(classifyAdminQuestion('Which stock is low?'), 'stock');
assert.equal(classifyAdminQuestion('How are M-Pesa payments?'), 'payments');
assert.equal(classifyAdminQuestion('How many support tickets are open?'), 'support');
assert.equal(classifyAdminQuestion('Summarise paid tips'), 'tips');
assert.equal(classifyAdminQuestion('Give me an overview'), 'sales');

const report = summarizeAdminData({
  orders: [
    { paymentStatus: 'PAID', orderStatus: 'DELIVERED', total: 2500, items: [{ quantity: 2, unitCost: 700 }] },
    { paymentStatus: 'PENDING', orderStatus: 'PENDING', total: 1000, items: [{ quantity: 1 }] },
  ],
  products: [
    { status: 'ACTIVE', inventory: [{ quantity: 2 }, { quantity: 0 }, { quantity: 5 }] },
    { status: 'DRAFT', inventory: [{ quantity: 100 }] },
  ],
  tickets: [{ status: 'OPEN' }, { status: 'RESOLVED' }],
  tips: [{ status: 'PAID', amount: 300 }, { status: 'PENDING', amount: 500 }],
});

assert.equal(report.sales.paidOrderCount, 1);
assert.equal(report.sales.paidOrderValue, 2500);
assert.equal(report.stock.activeProducts, 1);
assert.equal(report.stock.unitsInStock, 7);
assert.equal(report.stock.lowStockVariants, 1);
assert.equal(report.stock.outOfStockVariants, 1);
assert.equal(report.support.ticketCount, 2);
assert.equal(report.tips.paidTipCount, 1);
assert.equal(report.tips.paidTipValue, 300);
assert.equal(report.profit.knownGrossProfit, 1100);
assert.equal(report.profit.knownCostPaidOrderCount, 1);

const missingCosts = summarizeAdminData({
  orders: [{ paymentStatus: 'PAID', orderStatus: 'DELIVERED', total: 9999, items: [{ quantity: 1 }] }],
});
assert.equal(missingCosts.profit.knownGrossProfit, null);
assert.match(buildAdminFallbackAnswer('profit', missingCosts), /can’t calculate a reliable profit/i);

console.log('test-admin-ai: all assertions passed');
