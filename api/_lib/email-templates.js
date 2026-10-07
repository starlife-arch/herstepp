// HTML email templates (HerStep Collection brand). Pure functions — no DB, no
// network — so they are unit-testable offline. EVERY user-supplied value is
// escaped; nothing from Firestore ever reaches the template unescaped.
// ONE site URL for every link: api/_lib/site-url.js (no hardcoded deploys).
import { siteUrl } from './site-url.js';
import { invoiceNumberFor } from './invoice-number.js';

export { siteUrl };

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const BRAND_NAVY = '#10233f';
const BRAND_ACCENT = '#b96f40';
const BRAND_TEXT = '#40516a';

const FOOTER_LINE = 'HerStep Collection · Juja Town, Jerry House, near Juja Posta, Outside Shop No. 12 · +254 799 021 089 · herstepcollection@gmail.com';

// Responsive table layout: header band, body, optional CTA button, footer.
// options.rawBody = true keeps the body as pre-built (already escaped) HTML —
// used by the verification-code template, which renders the code in a styled
// block. Every other caller passes plain text, which is escaped here.
export function emailHtml(title, body, { ctaLabel, ctaUrl, rawBody = false } = {}) {
  const safeTitle = escapeHtml(title);
  const safeBody = rawBody ? String(body ?? '') : escapeHtml(body).replace(/\n/g, '<br>');
  const button = ctaLabel && ctaUrl
    ? `<tr><td align="center" style="padding:24px 0 8px;">
         <a href="${escapeHtml(String(ctaUrl))}" target="_blank" rel="noopener"
            style="display:inline-block;background:${BRAND_NAVY};color:#ffffff;text-decoration:none;font-family:Arial,sans-serif;font-size:15px;font-weight:bold;padding:12px 28px;border-radius:6px;">${escapeHtml(ctaLabel)}</a>
       </td></tr>`
    : '';
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${safeTitle}</title></head>
<body style="margin:0;padding:0;background:#f4f5f7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #e6e8ec;">
<tr><td style="background:${BRAND_NAVY};padding:22px 28px;">
  <div style="font-family:Arial,sans-serif;color:#ffffff;font-size:18px;font-weight:bold;letter-spacing:2px;">HERSTEP COLLECTION</div>
  <div style="font-family:Arial,sans-serif;color:${BRAND_ACCENT};font-size:12px;margin-top:4px;">Step Into Your Style.</div>
</td></tr>
<tr><td style="padding:28px;font-family:Arial,sans-serif;">
  <h1 style="margin:0 0 14px;font-size:19px;color:${BRAND_NAVY};">${safeTitle}</h1>
  <div style="font-size:14px;line-height:1.6;color:${BRAND_TEXT};">${safeBody}</div>
  ${button}
</td></tr>
<tr><td style="padding:16px 28px;border-top:1px solid #eceef1;font-family:Arial,sans-serif;font-size:11px;line-height:1.6;color:#8a93a2;">${escapeHtml(FOOTER_LINE)}</td></tr>
</table>
</td></tr></table>
</body></html>`;
}

export function buildEmail(title, body, options = {}) {
  return { subject: String(title), htmlContent: emailHtml(title, body, options) };
}

// 6-digit email-verification code email. Deliberately has NO links and NO CTA
// button (the branded shell is reused without ctaLabel/ctaUrl) — a phishing
// email copy would be useless. The code is rendered as large spaced digits;
// each digit goes through escapeHtml like every other user-supplied value.
export function verificationCodeEmail(code) {
  const safeCode = escapeHtml(String(code ?? '').replace(/\D/g, '').slice(0, 6));
  const digits = safeCode.split('').join('&#8202;'); // thin spaces between digits
  const body = [
    'Enter this code on the HerStep website to verify your email address:',
    `<div style="margin:22px 0;text-align:center;font-family:Arial,sans-serif;font-size:34px;font-weight:bold;letter-spacing:8px;color:${BRAND_NAVY};">${digits}</div>`,
    'It expires in 10 minutes. If you did not request this, ignore this email.',
  ].join('\n');
  return {
    subject: `Your HerStep verification code: ${safeCode}`,
    htmlContent: emailHtml('Verify your email', body, { rawBody: true }),
  };
}

const money = n => `KSh ${(Number(n) || 0).toLocaleString('en-KE')}`;

const STATUS_COLOURS = { PAID: '#1f6a53', PENDING: '#a25f20' };
const statusColour = s => STATUS_COLOURS[String(s || '').toUpperCase()] || '#b42318'; // failures red

const PICKUP_ADDRESS = 'Juja Town, Jerry House, near Juja Posta, Outside Shop No. 12';

// Order receipt / status email. Works for PAID orders and for failed/cancelled/
// timed-out payment notices (adds a "Pay now" CTA in that case).
export function orderReceiptEmail(order, status) {
  const o = order || {};
  const st = String(status || o.paymentStatus || 'PENDING').toUpperCase();
  const name = o.delivery?.fullName || o.customerName || 'there';
  const orderId = o.orderId || '';
  const paid = st === 'PAID';
  const delivery = o.delivery || {};
  const method = String(delivery.deliveryMethod || 'COLLECTION').toUpperCase();
  const items = Array.isArray(o.items) ? o.items : [];

  const itemRows = items.map(i => `
<tr>
  <td style="padding:8px 10px;border-bottom:1px solid #eceef1;font-family:Arial,sans-serif;font-size:13px;color:${BRAND_TEXT};">${escapeHtml(i.name || 'Item')}</td>
  <td align="center" style="padding:8px 10px;border-bottom:1px solid #eceef1;font-family:Arial,sans-serif;font-size:13px;color:${BRAND_TEXT};">Size ${escapeHtml(i.size)}</td>
  <td align="center" style="padding:8px 10px;border-bottom:1px solid #eceef1;font-family:Arial,sans-serif;font-size:13px;color:${BRAND_TEXT};">${Number(i.quantity) || 0}</td>
  <td align="right" style="padding:8px 10px;border-bottom:1px solid #eceef1;font-family:Arial,sans-serif;font-size:13px;color:${BRAND_TEXT};">${escapeHtml(money(i.unitPrice))}</td>
  <td align="right" style="padding:8px 10px;border-bottom:1px solid #eceef1;font-family:Arial,sans-serif;font-size:13px;color:${BRAND_TEXT};">${escapeHtml(money(i.lineTotal))}</td>
</tr>`).join('');

  const totals = [];
  totals.push(['Subtotal', o.subtotal]);
  if (Number(o.discount) > 0) totals.push([`Discount${o.promoCode ? ` (${o.promoCode})` : ''}`, -(Number(o.discount) || 0)]);
  totals.push(['Delivery fee', o.deliveryFee]);
  totals.push(['Total', o.total]);
  const totalRows = totals.map(([label, v], idx) => `
<tr>
  <td align="left" style="padding:6px 10px;font-family:Arial,sans-serif;font-size:13px;color:${BRAND_TEXT};${idx === totals.length - 1 ? 'font-weight:bold;' : ''}">${escapeHtml(label)}</td>
  <td align="right" style="padding:6px 10px;font-family:Arial,sans-serif;font-size:13px;color:${BRAND_TEXT};${idx === totals.length - 1 ? 'font-weight:bold;' : ''}">${escapeHtml(money(v))}</td>
</tr>`).join('');

  const lines = [
    `Hi ${name},`,
    paid
      ? `Thank you! We have received your M-Pesa payment for order ${orderId}.`
      : `Your payment for order ${orderId} was ${st.toLowerCase()}.${o.failureReason ? ` Reason: ${o.failureReason}` : ''}`,
  ];

  const details = [];
  details.push(`<strong>Order:</strong> ${escapeHtml(orderId)}`);
  details.push(`<span style="display:inline-block;margin:2px 0;padding:3px 10px;border-radius:4px;background:${statusColour(st)};color:#fff;font-size:12px;font-weight:bold;">${escapeHtml(st)}</span>`);
  details.push(`<strong>Delivery:</strong> ${method === 'COLLECTION' ? `Collection at ${escapeHtml(PICKUP_ADDRESS)}` : `to ${escapeHtml(delivery.location || '—')}`}`);
  if (delivery.phone) details.push(`<strong>Phone:</strong> ${escapeHtml(delivery.phone)}`);
  if (delivery.instructions) details.push(`<strong>Notes:</strong> ${escapeHtml(delivery.instructions)}`);
  if (paid && o.receiptNumber) details.push(`<strong>M-Pesa receipt:</strong> ${escapeHtml(o.receiptNumber)}`);
  // PAID receipts now travel WITH a second, separate invoice email (sender
  // invoices@). Tell the customer so they do not think this email is missing
  // its PDF.
  if (paid) details.push('Your invoice is in a separate email from invoices@ and in your account under My Orders.');

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Order ${escapeHtml(orderId)}</title></head>
<body style="margin:0;padding:0;background:#f4f5f7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #e6e8ec;">
<tr><td style="background:${BRAND_NAVY};padding:22px 28px;">
  <div style="font-family:Arial,sans-serif;color:#ffffff;font-size:18px;font-weight:bold;letter-spacing:2px;">HERSTEP COLLECTION</div>
  <div style="font-family:Arial,sans-serif;color:${BRAND_ACCENT};font-size:12px;margin-top:4px;">Step Into Your Style.</div>
</td></tr>
<tr><td style="padding:28px;font-family:Arial,sans-serif;">
  <p style="margin:0 0 10px;font-size:14px;line-height:1.6;color:${BRAND_TEXT};">${escapeHtml(lines[0])}</p>
  <p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:${BRAND_TEXT};">${escapeHtml(lines[1])}</p>
  <div style="font-size:13px;line-height:1.9;color:${BRAND_TEXT};margin-bottom:18px;">${details.join('<br>')}</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eceef1;border-radius:6px;margin-bottom:14px;">
    <tr>
      <th align="left" style="padding:8px 10px;background:#f7f8fa;font-family:Arial,sans-serif;font-size:12px;color:${BRAND_NAVY};">Item</th>
      <th align="center" style="padding:8px 10px;background:#f7f8fa;font-family:Arial,sans-serif;font-size:12px;color:${BRAND_NAVY};">Size</th>
      <th align="center" style="padding:8px 10px;background:#f7f8fa;font-family:Arial,sans-serif;font-size:12px;color:${BRAND_NAVY};">Qty</th>
      <th align="right" style="padding:8px 10px;background:#f7f8fa;font-family:Arial,sans-serif;font-size:12px;color:${BRAND_NAVY};">Unit</th>
      <th align="right" style="padding:8px 10px;background:#f7f8fa;font-family:Arial,sans-serif;font-size:12px;color:${BRAND_NAVY};">Total</th>
    </tr>${itemRows}
  </table>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin-bottom:20px;">${totalRows}</table>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    <td align="center" style="padding:4px 6px;">
      <a href="${escapeHtml(`${siteUrl()}/dashboard`)}" target="_blank" rel="noopener" style="display:inline-block;background:${BRAND_NAVY};color:#fff;text-decoration:none;font-family:Arial,sans-serif;font-size:14px;font-weight:bold;padding:11px 22px;border-radius:6px;">View your order</a>
    </td>
    ${!paid && o.id ? `<td align="center" style="padding:4px 6px;">
      <a href="${escapeHtml(`${siteUrl()}/checkout?order=${encodeURIComponent(o.id)}`)}" target="_blank" rel="noopener" style="display:inline-block;background:${BRAND_ACCENT};color:#fff;text-decoration:none;font-family:Arial,sans-serif;font-size:14px;font-weight:bold;padding:11px 22px;border-radius:6px;">Pay now</a>
    </td>` : ''}
  </tr></table>
</td></tr>
<tr><td style="padding:16px 28px;border-top:1px solid #eceef1;font-family:Arial,sans-serif;font-size:11px;line-height:1.6;color:#8a93a2;">${escapeHtml(FOOTER_LINE)}</td></tr>
</table>
</td></tr></table>
</body></html>`;

  const subject = paid
    ? `Payment received — order ${orderId} | HerStep Collection`
    : `Payment ${st.toLowerCase()} — order ${orderId} | HerStep Collection`;
  return { subject, htmlContent: html };
}

// Invoice email sent for PAID orders — the SECOND of two emails (the first is
// the payment-received receipt from orderReceiptEmail, purpose 'payments').
// Deterministic outbox key `${orderDocId}-INVOICE` upstream. The PDF is NOT
// embedded here — the outbox record carries attachInvoiceFor and the delivery
// pass generates it at send time (see api/_lib/invoice-pdf.js).
export function invoiceEmail(order) {
  const o = order || {};
  const orderId = o.orderId || '';
  const invoiceNumber = o.invoiceNumber || invoiceNumberFor(orderId);
  const name = o.delivery?.fullName || o.customerName || 'there';
  const delivery = o.delivery || {};
  const method = String(delivery.deliveryMethod || 'COLLECTION').toUpperCase();
  const items = Array.isArray(o.items) ? o.items : [];
  const date = (() => {
    const ms = (() => {
      const v = o.paidAt || o.paymentCompletedAt || o.createdAt;
      if (!v) return Date.now();
      if (typeof v === 'number') return v;
      if (typeof v === 'string') return Date.parse(v) || Date.now();
      if (typeof v.toDate === 'function') return v.toDate().getTime();
      return Date.now();
    })();
    return new Intl.DateTimeFormat('en-GB', { day: '2-digit', month: 'long', year: 'numeric', timeZone: 'Africa/Nairobi' }).format(new Date(ms));
  })();

  const th = 'align="left" style="padding:8px 10px;background:#f7f8fa;font-family:Arial,sans-serif;font-size:12px;color:' + BRAND_NAVY + ';"';
  const itemRows = items.map(i => `
<tr>
  <td style="padding:8px 10px;border-bottom:1px solid #eceef1;font-family:Arial,sans-serif;font-size:13px;color:${BRAND_TEXT};">${escapeHtml(i.name || 'Item')}</td>
  <td align="center" style="padding:8px 10px;border-bottom:1px solid #eceef1;font-family:Arial,sans-serif;font-size:13px;color:${BRAND_TEXT};">Size ${escapeHtml(i.size)}</td>
  <td align="center" style="padding:8px 10px;border-bottom:1px solid #eceef1;font-family:Arial,sans-serif;font-size:13px;color:${BRAND_TEXT};">${Number(i.quantity) || 0}</td>
  <td align="right" style="padding:8px 10px;border-bottom:1px solid #eceef1;font-family:Arial,sans-serif;font-size:13px;color:${BRAND_TEXT};">${escapeHtml(money(i.unitPrice))}</td>
  <td align="right" style="padding:8px 10px;border-bottom:1px solid #eceef1;font-family:Arial,sans-serif;font-size:13px;color:${BRAND_TEXT};">${escapeHtml(money(i.lineTotal))}</td>
</tr>`).join('');

  const totals = [];
  totals.push(['Subtotal', o.subtotal]);
  if (Number(o.discount) > 0) totals.push([`Discount${o.promoCode ? ` (${o.promoCode})` : ''}`, -(Number(o.discount) || 0)]);
  totals.push(['Delivery', o.deliveryFee]);
  totals.push(['TOTAL PAID', o.total]);
  const totalRows = totals.map(([label, v], idx) => `
<tr>
  <td align="left" style="padding:6px 10px;font-family:Arial,sans-serif;font-size:13px;color:${idx === totals.length - 1 ? '#1f6a53' : BRAND_TEXT};${idx === totals.length - 1 ? 'font-weight:bold;' : ''}">${escapeHtml(label)}</td>
  <td align="right" style="padding:6px 10px;font-family:Arial,sans-serif;font-size:13px;color:${idx === totals.length - 1 ? '#1f6a53' : BRAND_TEXT};${idx === totals.length - 1 ? 'font-weight:bold;' : ''}">${escapeHtml(money(v))}</td>
</tr>`).join('');

  const label = l => `<div style="font-family:Arial,sans-serif;font-size:11px;letter-spacing:1px;color:#8a93a2;margin-top:14px;">${escapeHtml(l)}</div>`;
  const row = (k, v) => `<div style="font-family:Arial,sans-serif;font-size:13px;line-height:1.7;color:${BRAND_TEXT};"><strong>${escapeHtml(k)}:</strong> ${escapeHtml(v ?? '—')}</div>`;

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Invoice ${escapeHtml(invoiceNumber)}</title></head>
<body style="margin:0;padding:0;background:#f4f5f7;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;">
<tr><td align="center" style="padding:24px 12px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:10px;overflow:hidden;border:1px solid #e6e8ec;">
<tr><td style="background:${BRAND_NAVY};padding:22px 28px;">
  <div style="font-family:Arial,sans-serif;color:#ffffff;font-size:18px;font-weight:bold;letter-spacing:2px;">HERSTEP COLLECTION</div>
  <div style="font-family:Arial,sans-serif;color:${BRAND_ACCENT};font-size:12px;margin-top:4px;">Payment receipt / Invoice</div>
</td></tr>
<tr><td style="padding:28px;font-family:Arial,sans-serif;">
  <p style="margin:0 0 18px;font-size:14px;line-height:1.6;color:${BRAND_TEXT};">Hi ${escapeHtml(name)},<br>Payment received successfully. Your invoice for order ${escapeHtml(orderId)} is attached.</p>
  ${row('Invoice number', invoiceNumber)}
  ${row('Order number', orderId)}
  <div style="margin:10px 0;"><span style="display:inline-block;padding:3px 10px;border-radius:4px;background:#1f6a53;color:#fff;font-size:12px;font-weight:bold;">PAID</span></div>
  ${row('Date', date)}
  ${label('CUSTOMER')}
  ${row('Name', o.delivery?.fullName || o.customerName)}
  ${row('Phone', delivery.phone)}
  ${row('Email', o.customerEmail)}
  ${label('DELIVERY / COLLECTION')}
  ${row('Method', method === 'COLLECTION' ? 'Collection at the store' : 'Delivery')}
  ${method === 'COLLECTION' ? row('Pickup address', PICKUP_ADDRESS) : row('Location', delivery.location || '—')}
  ${delivery.instructions ? row('Delivery instructions', delivery.instructions) : ''}
  ${label('ORDER DETAILS')}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #eceef1;border-radius:6px;margin-top:6px;">
    <tr>
      <th ${th}>Item</th>
      <th align="center" style="padding:8px 10px;background:#f7f8fa;font-family:Arial,sans-serif;font-size:12px;color:${BRAND_NAVY};">Size</th>
      <th align="center" style="padding:8px 10px;background:#f7f8fa;font-family:Arial,sans-serif;font-size:12px;color:${BRAND_NAVY};">Qty</th>
      <th align="right" style="padding:8px 10px;background:#f7f8fa;font-family:Arial,sans-serif;font-size:12px;color:${BRAND_NAVY};">Unit</th>
      <th align="right" style="padding:8px 10px;background:#f7f8fa;font-family:Arial,sans-serif;font-size:12px;color:${BRAND_NAVY};">Total</th>
    </tr>${itemRows}
  </table>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:14px 0 20px;">${totalRows}</table>
  ${label('PAYMENT')}
  ${row('Method', 'M-Pesa')}
  ${row('M-Pesa receipt', o.receiptNumber || o.paymentReference || '—')}
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr>
    <td align="center" style="padding:16px 6px 4px;">
      <a href="${escapeHtml(`${siteUrl()}/dashboard`)}" target="_blank" rel="noopener" style="display:inline-block;background:${BRAND_NAVY};color:#fff;text-decoration:none;font-family:Arial,sans-serif;font-size:14px;font-weight:bold;padding:11px 22px;border-radius:6px;">View your order</a>
    </td>
  </tr></table>
</td></tr>
<tr><td style="padding:16px 28px;border-top:1px solid #eceef1;font-family:Arial,sans-serif;font-size:11px;line-height:1.6;color:#8a93a2;">${escapeHtml(FOOTER_LINE)}</td></tr>
</table>
</td></tr></table>
</body></html>`;

  return { subject: `Invoice ${invoiceNumber} - payment received for order ${orderId}`, htmlContent: html };
}

// Contact-form auto-reply (purpose 'support'). NO links by design — the form
// is public and unverified, so a bot could otherwise farm branded clicks.
// The body is plain text; emailHtml escapes every value inside it.
export function contactReceivedEmail(message) {
  const name = String(message?.name || '').trim() || 'there';
  const messageId = String(message?.messageId || '').trim();
  const body = [
    `Hi ${name},`,
    '',
    `We received your message${messageId ? ` (reference ${messageId})` : ''}.`,
    'Our team usually replies within one working day.',
    '',
    'You can also reach us on +254 799 021 089 or herstepcollection@gmail.com.',
  ].join('\n');
  return {
    subject: 'We received your message - HerStep Collection',
    htmlContent: emailHtml('We received your message', body),
  };
}

// Admin reply to a contact message (purpose 'support'). The customer's
// original text is quoted below the answer; both are escaped here because
// rawBody keeps emailHtml from escaping again.
export function contactReplyEmail({ name, body, originalMessage, messageId }) {
  const safeName = escapeHtml(name || 'there');
  const safeBody = escapeHtml(body).replace(/\n/g, '<br>');
  const safeOriginal = escapeHtml(originalMessage || '').replace(/\n/g, '<br>');
  const quote = safeOriginal
    ? `<div style="margin-top:22px;padding:12px 14px;background:#f7f8fa;border-left:3px solid ${BRAND_ACCENT};border-radius:4px;font-family:Arial,sans-serif;font-size:12px;line-height:1.6;color:${BRAND_TEXT};"><div style="font-size:11px;letter-spacing:1px;color:#8a93a2;margin-bottom:6px;">YOUR MESSAGE${messageId ? ` (${escapeHtml(messageId)})` : ''}</div>${safeOriginal}</div>`
    : '';
  const inner = `<p style="margin:0 0 14px;font-size:14px;line-height:1.6;color:${BRAND_TEXT};">Hi ${safeName},</p><div style="font-size:14px;line-height:1.6;color:${BRAND_TEXT};">${safeBody}</div>${quote}`;
  return {
    subject: 'Re: your message to HerStep Collection',
    htmlContent: emailHtml('Re: your message to HerStep Collection', inner, { rawBody: true }),
  };
}
