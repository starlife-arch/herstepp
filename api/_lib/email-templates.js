// HTML email templates (HerStep Collection brand). Pure functions — no DB, no
// network — so they are unit-testable offline. EVERY user-supplied value is
// escaped; nothing from Firestore ever reaches the template unescaped.
const SITE_URL_DEFAULT = 'https://herstepp.vercel.app';

export function siteUrl() {
  return String((globalThis.process?.env || {}).SITE_URL || SITE_URL_DEFAULT).replace(/\/+$/, '');
}

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
export function emailHtml(title, body, { ctaLabel, ctaUrl } = {}) {
  const safeTitle = escapeHtml(title);
  const safeBody = escapeHtml(body).replace(/\n/g, '<br>');
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
