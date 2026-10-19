import assert from 'node:assert/strict';
import { PDFDocument } from 'pdf-lib';
import { buildMarketplaceInvoicePdf } from '../api/_lib/invoice-pdf.js';

const order = {
  orderId: 'HS-MKT-20261019-001',
  customerName: 'Buyer Example',
  customerEmail: 'buyer@example.com',
  customerPhone: '+254712345678',
  paymentReference: 'QABC123XYZ',
  total: 5400,
  delivery: {
    fullName: 'Buyer Example',
    phone: '+254712345678',
    deliveryMethod: 'DELIVERY',
    location: 'Juja, Kiambu',
    instructions: 'Call on arrival',
  },
};
const seller = {
  businessName: 'Seller Example Boutique',
  displayName: 'Seller Example',
  phone: '+254711111111',
  email: 'seller@example.com',
};
const items = [
  { name: 'Black leather handbag', size: 'One Size', quantity: 1, unitPrice: 2500, lineTotal: 2500 },
  { name: 'Gold necklace', size: 'One Size', quantity: 2, unitPrice: 1450, lineTotal: 2900 },
];

const bytes = await buildMarketplaceInvoicePdf({
  order, seller, items, invoiceNumber: 'MKT-HS20261019-001-SELL1', receiptNumber: 'QABC123XYZ',
});
assert.ok(bytes instanceof Uint8Array);
assert.ok(bytes.length > 1000, 'marketplace invoice should contain a rendered PDF');
const pdf = await PDFDocument.load(bytes);
assert.equal(pdf.getPageCount(), 1, 'small seller invoice should fit on one page');

const manyItems = Array.from({ length: 60 }, (_, index) => ({
  name: 'Seller product ' + (index + 1),
  size: 'One Size',
  quantity: 1,
  unitPrice: 100 + index,
  lineTotal: 100 + index,
}));
const multiPageBytes = await buildMarketplaceInvoicePdf({
  order, seller, items: manyItems, invoiceNumber: 'MKT-LONG-001', receiptNumber: 'QABC123XYZ',
});
const multiPagePdf = await PDFDocument.load(multiPageBytes);
assert.ok(multiPagePdf.getPageCount() > 1, 'large seller invoices should continue on another page');
console.log('Marketplace invoice PDF tests passed.');
