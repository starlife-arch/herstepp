// Single source of truth for admin order-status transitions on the frontend.
// Mirrors ALLOWED_ORDER_TRANSITIONS in api/_lib/order-core.js — keep both in
// sync when the workflow changes. The API still validates every transition
// server-side; this map only controls which options the UI offers.
export const ORDER_STATUSES = [
  'PENDING',
  'PROCESSING',
  'PROCESSED',
  'OUT_FOR_DELIVERY',
  'DELIVERED',
  'CANCELLED',
] as const;

export type OrderStatus = (typeof ORDER_STATUSES)[number];

export const ALLOWED_ORDER_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  PENDING: ['PROCESSING', 'CANCELLED'],
  PROCESSING: ['PROCESSED', 'CANCELLED'],
  PROCESSED: ['OUT_FOR_DELIVERY', 'CANCELLED'],
  OUT_FOR_DELIVERY: ['DELIVERED', 'CANCELLED'],
  DELIVERED: [], // terminal
  CANCELLED: [], // terminal
};

/** Allowed next statuses for an order's current status ([] when terminal). */
export function nextOrderStatuses(current: string | undefined | null): OrderStatus[] {
  return ALLOWED_ORDER_TRANSITIONS[current as OrderStatus] || [];
}

/** "OUT_FOR_DELIVERY" -> "Out For Delivery" (human labels everywhere). */
export function humanStatus(s: string | undefined | null): string {
  return String(s || '')
    .split('_')
    .map(w => (w ? w[0] + w.slice(1).toLowerCase() : w))
    .join(' ');
}
