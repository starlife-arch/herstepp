// A4 invoice PDF built with pdf-lib (Helvetica only — no font files).
//
// HARD RULES:
//   * Every piece of text goes through winansi() first: unsupported glyphs
//     become '?', control characters and repeated whitespace collapse, long
//     strings truncate. Strange characters can NEVER crash generation.
//   * Amounts/items come from the caller (Firestore documents) — this module
//     never reads a database and never makes network calls.
//   * Money is formatted "KSh 1,250".
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { siteUrl } from './site-url.js';
import { invoiceNumberFor } from './invoice-number.js';
import { COLLECTION_LOCATION } from './delivery.js';

// Store pickup address — the SAME constant the rest of the app uses.
const STORE_PICKUP_ADDRESS = COLLECTION_LOCATION;

// Store constants — exactly what the site footer shows (src/components/Layout.tsx):
// Phone +254 799 021 089, WhatsApp +254 106 624 924 (wa.me/254106624924),
// website herstepcollection.shop, address Juja Town.
export const STORE = {
  name: 'HERSTEP',
  tagline: 'COLLECTION - STEP INTO YOUR STYLE',
  address: 'Juja Town, Kenya',
  phone: '+254 799 021 089',
  whatsapp: '+254 106 624 924',
  whatsappLink: 'https://wa.me/254106624924',
};

const NAVY = rgb(0x10 / 255, 0x23 / 255, 0x3f / 255);
const GREEN = rgb(0x15 / 255, 0x80 / 255, 0x3d / 255);
const TEXT = rgb(0x2a / 255, 0x33 / 255, 0x44 / 255);
const MUTED = rgb(0x6b / 255, 0x74 / 255, 0x85 / 255);
const LINE = rgb(0xd9 / 255, 0xdd / 255, 0xe4 / 255);

const PAGE_W = 595.28; // A4 portrait
const PAGE_H = 841.89;
const MARGIN = 48;

// Map any string to characters WinAnsi can encode. Non-Latin-1 code points
// (emoji, Arabic, ...) become '?'; CJK ideographs happen to be Latin-1-free
// too, so they also become '?' — that is intentional: never crash.
export function winansi(value, maxLen = 120) {
  let s = String(value ?? '');
  s = s.normalize('NFKD');
  let out = '';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp === 9) { out += ' '; continue; }            // tab -> space
    if (cp >= 32 && cp <= 126) { out += ch; continue; } // printable ASCII
    if (cp > 126 && cp < 256) { out += '?'; continue; } // accented latin etc.: keep simple
    if (cp === 0x2018 || cp === 0x2019) { out += "'"; continue; }
    if (cp === 0x201c || cp === 0x201d) { out += '"'; continue; }
    if (cp === 0x2013 || cp === 0x2014) { out += '-'; continue; }
    if (cp === 0x20ac) { out += 'EUR'; continue; }
    if (cp === 0xa3) { out += 'GBP'; continue; }
    out += '?';
  }
  out = out.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '').replace(/\s+/g, ' ').trim();
  if (out.length > maxLen) out = `${out.slice(0, Math.max(0, maxLen - 1))}...`;
  return out;
}

export function moneyKsh(amount) {
  const n = Number(amount);
  const safe = Number.isFinite(n) ? n : 0;
  return `KSh ${safe.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July',
  'August', 'September', 'October', 'November', 'December'];

// Format an ISO string / epoch ms / Firestore timestamp in Africa/Nairobi
// (UTC+3, no DST) as e.g. "05 October 2026".
export function dateNairobi(value) {
  let ms = null;
  if (value instanceof Date) ms = value.getTime();
  else if (typeof value === 'number') ms = value;
  else if (typeof value === 'string' && value) ms = Date.parse(value);
  else if (value && typeof value === 'object' && typeof value.toDate === 'function') ms = value.toDate().getTime();
  if (ms == null || Number.isNaN(ms)) ms = Date.now();
  const shifted = new Date(ms + 3 * 60 * 60 * 1000); // Nairobi = UTC+3 year-round
  const day = String(shifted.getUTCDate()).padStart(2, '0');
  return `${day} ${MONTHS[shifted.getUTCMonth()]} ${shifted.getUTCFullYear()}`;
}

// Delivery / collection line for the PDF. Real orders NEVER set
// order.deliveryType or delivery.type — the ONLY field that exists is
// delivery.deliveryMethod ("COLLECTION" | "DELIVERY"), exactly like the email
// templates read it (api/_lib/email-templates.js). Anything else defaults to
// COLLECTION so nothing ever prints a wrong address.
function deliveryLine(order) {
  const d = order.delivery || {};
  const method = String(d.deliveryMethod || 'COLLECTION').toUpperCase();
  if (method === 'DELIVERY') {
    const where = d.location || [d.county, d.town].filter(Boolean).join(', ') || d.address || '';
    return { method: 'Delivery', where };
  }
  return { method: 'Collection (pick up in store)', where: STORE_PICKUP_ADDRESS };
}

// ---------------------------------------------------------------------------
export async function buildInvoicePdf({ order, payment }) {
  const o = order || {};
  const p = payment || {};
  const invoiceNumber = winansi(o.invoiceNumber || invoiceNumberFor(o.orderId), 40);
  const orderId = winansi(o.orderId || '', 40);

  const doc = await PDFDocument.create();
  doc.setTitle(`HerStep Invoice ${invoiceNumber}`);
  doc.setProducer('HerStep Collection');
  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  let page = doc.addPage([PAGE_W, PAGE_H]);
  let y = PAGE_H - MARGIN;

  const text = (str, x, yy, size, font = regular, color = TEXT) => {
    page.drawText(winansi(str, 300), { x, y: yy, size, font, color });
  };
  const rule = (yy, x1 = MARGIN, x2 = PAGE_W - MARGIN) => {
    page.drawLine({ start: { x: x1, y: yy }, end: { x: x2, y: yy }, thickness: 1, color: LINE });
  };
  const sectionTitle = (label) => text(label.toUpperCase(), MARGIN, y, 9, bold, MUTED);
  const newPageIfNeeded = (needed) => {
    if (y - needed < MARGIN + 140) {
      page = doc.addPage([PAGE_W, PAGE_H]);
      y = PAGE_H - MARGIN;
      return true;
    }
    return false;
  };

  // ---- Header -------------------------------------------------------------
  text(STORE.name, MARGIN, y, 26, bold, NAVY);
  text(STORE.tagline, MARGIN, y - 18, 10, regular, MUTED);
  text(STORE.address, MARGIN, y - 34, 10, regular, MUTED);

  const rightX = PAGE_W - MARGIN;
  text('INVOICE', rightX - 120, y, 20, bold, NAVY);
  text(invoiceNumber, rightX - 120, y - 18, 11, bold, TEXT);
  text(`Order ${orderId}`, rightX - 120, y - 34, 10, regular, MUTED);

  // Green PAID badge (right under the invoice block).
  const badgeW = 64;
  const badgeH = 20;
  const bx = rightX - badgeW;
  const by = y - 66;
  page.drawRectangle({ x: bx, y: by, width: badgeW, height: badgeH, color: GREEN, borderRadius: 4 });
  page.drawText('PAID', { x: bx + 16, y: by + 6, size: 11, font: bold, color: rgb(1, 1, 1) });

  y -= 96;
  rule(y);
  y -= 24;

  // ---- Billed to / invoice details ------------------------------------------
  // TWO clearly separated columns. "INVOICE DETAILS" is drawn at the RIGHT
  // column (colR) — drawing it at MARGIN made it overlap "BILLED TO". Long
  // names/emails/addresses wrap onto extra lines instead of colliding, and the
  // section height adapts so nothing below ever overlaps.
  const colL = MARGIN;
  const colR = PAGE_W - MARGIN - 220;
  const COL_W_L = colR - MARGIN - 16;   // usable width of the left column
  const COL_W_R = PAGE_W - MARGIN - colR; // usable width of the right column
  const LINE_H = 14;

  // Word-wrap a value into <= maxLines visual lines within `width` (truncates
  // with an ellipsis on the last line if it still overflows).
  const wrapLines = (value, font, size, width, maxLines) => {
    const words = winansi(value, 200).split(' ').filter(Boolean);
    if (!words.length) return ['-'];
    const lines = [];
    let current = '';
    for (const word of words) {
      const candidate = current ? `${current} ${word}` : word;
      if (font.widthOfTextAtSize(candidate, size) <= width || !current) {
        current = candidate;
      } else {
        lines.push(current);
        current = word;
      }
    }
    if (current) lines.push(current);
    while (lines.length > maxLines) {
      const kept = lines.slice(0, maxLines - 1);
      let tail = lines.slice(maxLines - 1).join(' ');
      while (tail && font.widthOfTextAtSize(`${tail}...`, size) > width) tail = tail.slice(0, -1);
      kept.push(`${tail}...`);
      return kept;
    }
    return lines;
  };

  text('BILLED TO', colL, y, 9, bold, MUTED);
  text('INVOICE DETAILS', colR, y, 9, bold, MUTED);
  y -= 18;

  const name = o.customerName || o.delivery?.fullName || '';
  const phone = o.delivery?.phone || o.customerPhone || '';
  const email = o.customerEmail || '';
  const issuedOn = dateNairobi(o.invoiceIssuedAt || p.completedAt || o.paidAt || o.createdAt);
  const paymentMethod = 'M-Pesa';

  const leftBlocks = [
    wrapLines(name, bold, 11, COL_W_L, 3),
    wrapLines(phone, regular, 10, COL_W_L, 1),
    wrapLines(email, regular, 10, COL_W_L, 2),
  ];
  const rightBlocks = [
    wrapLines(`Invoice date: ${issuedOn}`, regular, 10, COL_W_R, 2),
    wrapLines(`Order ${orderId}`, regular, 10, COL_W_R, 1),
    wrapLines(`Payment method: ${paymentMethod}`, regular, 10, COL_W_R, 1),
  ];

  const drawColumn = (blocks, x) => {
    let yy = y;
    blocks.forEach((block, blockIndex) => {
      const isNameBlock = blockIndex === 0 && x === colL;
      for (const line of block) {
        text(line, x, yy, isNameBlock ? 11 : 10, isNameBlock ? bold : regular, TEXT);
        yy -= LINE_H;
      }
      yy -= 2;
    });
    return yy;
  };
  const yAfterLeft = drawColumn(leftBlocks, colL);
  const yAfterRight = drawColumn(rightBlocks, colR);
  y = Math.min(yAfterLeft, yAfterRight) - 12;

  // ---- Delivery / collection ----------------------------------------------
  sectionTitle('Delivery / Collection');
  y -= 16;
  const dl = deliveryLine(o);
  text(dl.method, MARGIN, y, 11, regular, TEXT);
  if (dl.where) {
    y -= 15;
    for (const line of wrapLines(dl.where, regular, 10, PAGE_W - MARGIN * 2, 2)) {
      text(line, MARGIN, y, 10, regular, MUTED);
      y -= 13;
    }
  }
  // Instructions only when the customer actually left some.
  const instructions = o.deliveryInstructions || o.delivery?.instructions;
  if (instructions) {
    y -= 2;
    for (const line of wrapLines(instructions, regular, 10, PAGE_W - MARGIN * 2, 2)) {
      text(line, MARGIN, y, 10, regular, MUTED);
      y -= 13;
    }
  }
  y -= 24;

  // ---- Items table ---------------------------------------------------------
  const COLS = { item: MARGIN, size: MARGIN + 250, qty: MARGIN + 305, unit: MARGIN + 350, total: rightX };
  const headerRow = () => {
    rule(y + 12);
    text('Item', COLS.item, y, 9, bold, MUTED);
    text('Size', COLS.size, y, 9, bold, MUTED);
    text('Qty', COLS.qty, y, 9, bold, MUTED);
    text('Unit price', COLS.unit, y, 9, bold, MUTED);
    page.drawText('Total', { x: COLS.total - regular.widthOfTextAtSize('Total', 9), y, size: 9, font: bold, color: MUTED });
    y -= 18;
  };
  headerRow();
  const items = Array.isArray(o.items) ? o.items : [];
  for (const it of items) {
    if (y - 16 < MARGIN + 150) { page = doc.addPage([PAGE_W, PAGE_H]); y = PAGE_H - MARGIN; headerRow(); }
    const qty = Number(it.quantity) || 0;
    const unit = Number(it.price ?? it.unitPrice) || 0;
    page.drawText(winansi(it.name || it.productName || 'Item', 45), { x: COLS.item, y, size: 10, font: regular, color: TEXT });
    page.drawText(winansi(it.size || '-', 10), { x: COLS.size, y, size: 10, font: regular, color: TEXT });
    page.drawText(String(qty), { x: COLS.qty, y, size: 10, font: regular, color: TEXT });
    page.drawText(moneyKsh(unit), { x: COLS.unit, y, size: 10, font: regular, color: TEXT });
    const tot = moneyKsh(unit * qty);
    page.drawText(tot, { x: COLS.total - regular.widthOfTextAtSize(tot, 10), y, size: 10, font: regular, color: TEXT });
    y -= 16;
  }

  // ---- Totals ---------------------------------------------------------------
  y -= 6; rule(y); y -= 18;
  const amountLine = (label, value, opts = {}) => {
    const lx = PAGE_W - MARGIN - 220;
    if (opts.boldLabel) text(label, lx, y, 10, bold, opts.color || TEXT);
    else text(label, lx, y, 10, regular, MUTED);
    const vs = moneyKsh(value);
    page.drawText(vs, { x: rightX - (opts.boldValue ? bold : regular).widthOfTextAtSize(vs, opts.size || 10), y, size: opts.size || 10, font: opts.boldValue ? bold : regular, color: opts.color || TEXT });
    y -= 16;
  };
  amountLine('Subtotal', o.subtotal ?? 0);
  const discount = Number(o.discountAmount ?? o.discount ?? 0);
  if (discount > 0) {
    const promo = o.promoCode ? ` (${winansi(o.promoCode, 24)})` : '';
    amountLine(`Discount${promo}`, -discount);
  }
  amountLine('Delivery', o.deliveryFee ?? 0);
  y -= 4;
  rule(y + 12);
  y -= 14;
  amountLine('TOTAL PAID', o.total ?? p.amount ?? 0, { boldLabel: true, boldValue: true, color: GREEN, size: 13 });
  y -= 18;

  // ---- Payment ---------------------------------------------------------------
  sectionTitle('Payment');
  y -= 16;
  text('Method: M-Pesa', MARGIN, y, 10, regular, TEXT);
  y -= 15;
  const receipt = p.transactionReference || p.receiptNumber || o.paymentReference || '';
  text(`M-Pesa receipt: ${receipt || '-'}`, MARGIN, y, 10, regular, TEXT);
  y -= 34;

  // ---- Footer -----------------------------------------------------------------
  rule(y + 16);
  text('Thank you for shopping with HerStep Collection.', MARGIN, y, 11, bold, NAVY);
  y -= 16;
  text(`Phone ${STORE.phone}  ·  WhatsApp ${STORE.whatsapp}  ·  ${siteUrl().replace(/^https?:\/\//, '')}`, MARGIN, y, 9, regular, MUTED);
  y -= 14;
  text(STORE.address, MARGIN, y, 9, regular, MUTED);

  return new Uint8Array(await doc.save());
}
