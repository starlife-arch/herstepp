// Invoice number: derived from the (already unique) order id — no new counter.
// HS-2026-000056 -> INV-2026-000056. Anything else keeps its text with the
// HS- prefix swapped when present.
export function invoiceNumberFor(orderId) {
  const id = String(orderId || '');
  if (!id) return '';
  return id.startsWith('HS-') ? `INV-${id.slice(3)}` : `INV-${id}`;
}
