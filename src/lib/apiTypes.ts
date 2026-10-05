// Shared API response types — the single source of truth for every endpoint
// the frontend consumes. RULE (AGENTS.md): whenever an API response shape
// changes, update BOTH this file and every consumer in the same task, and keep
// scripts/test-api-contract.mjs green so TypeScript + tests catch drift.

export type IsoDate = string | null;

export interface OrderItem {
  productId: string;
  name: string;
  size: string;
  quantity: number;
  unitPrice: number;
  lineTotal: number;
  imageUrl?: string | null;
}

export interface OrderDelivery {
  fullName: string;
  phone: string;
  deliveryMethod: 'COLLECTION' | 'DELIVERY';
  location: string | null;
  instructions: string | null;
}

export interface StatusHistoryEntry {
  orderDocumentId?: string;
  previousStatus: string | null;
  newStatus: string;
  note: string | null;
  changedBy: string | null;
  source: string | null;
  createdAt: IsoDate;
}

export interface AdminOrderRow {
  id: string; // Firestore doc id — INTERNAL ONLY, never rendered to a user
  orderId: string; // HS-YYYY-NNNNNN — what humans see
  customerName: string | null;
  customerEmail: string | null;
  phone: string | null;
  delivery: OrderDelivery | null;
  items: OrderItem[];
  subtotal: number;
  deliveryFee: number;
  discount: number;
  total: number;
  paymentStatus: string; // PENDING | PAID | FAILED | CANCELLED | TIMEOUT
  orderStatus: string; // PENDING | PROCESSING | PROCESSED | OUT_FOR_DELIVERY | DELIVERED | CANCELLED
  paymentReference: string | null;
  receiptNumber: string | null;
  failureReason: string | null;
  needsReview?: boolean;
  createdAt: IsoDate;
  history?: StatusHistoryEntry[];
}

export interface PrintpayCallbackInfo {
  lastCallbackAt: string | null; // ISO
  lastCallbackStatus: string | null;
  lastCallbackCheckoutId: string | null;
  lastResultCode?: string | null;
  phoneLast4?: string | null;
}

// GET /api/admin/orders → { orders: [...], printpay: {...} }
export interface AdminOrdersResponse {
  orders: AdminOrderRow[];
  printpay: PrintpayCallbackInfo | null;
}

export interface DashboardOrder extends AdminOrderRow {
  statusHistory?: StatusHistoryEntry[];
}

export interface DashboardPayment {
  id: string;
  paymentId: string;
  orderId: string | null;
  orderDocumentId: string | null;
  amount: number;
  status: string;
  providerReference: string | null;
  transactionReference: string | null;
  receiptNumber: string | null;
  failureReason: string | null;
  createdAt: IsoDate;
  completedAt: IsoDate;
}

export interface DashboardNotification {
  id: string;
  title: string;
  message: string;
  read: boolean;
  createdAt: IsoDate;
}

// GET /api/dashboard → sections + warnings (a failed query never empties the
// page; it returns [] for that section and names it in `warnings`).
export interface DashboardResponse {
  orders: DashboardOrder[];
  payments: DashboardPayment[];
  notifications: DashboardNotification[];
  warnings: string[];
  // Server mirror of the Auth email_verified claim (set by
  // POST /api/auth/verify/confirm, or true at creation for Google accounts).
  // Drives the "Verify your email to place orders" banner on Dashboard and
  // Checkout. Absent on older payloads → treated as unverified.
  profile?: { emailVerified?: boolean } | null;
}

export interface PaymentShape {
  paymentId: string;
  orderId: string | null;
  status: string;
  amount: number;
  currency: string;
  phone: string;
  providerReference: string | null;
  transactionReference: string | null;
  receiptNumber: string | null;
  failureReason: string | null;
  createdAt: IsoDate;
  initiatedAt: IsoDate;
  completedAt: IsoDate;
}

// GET /api/payments/status and POST /api/payments/stk/initiate responses.
export interface PaymentStatusResponse {
  payment: PaymentShape;
}

// POST /api/orders/create response (only the fields Checkout uses).
export interface CreateOrderResponse {
  order: {
    id: string; // Firestore doc id — INTERNAL ONLY
    orderId: string; // HS-YYYY-NNNNNN — display everywhere
    total: number;
    paymentStatus: string;
    orderStatus: string;
  };
}

// GET /api/checkout/config
export interface CheckoutConfigResponse {
  deliveryEnabled: boolean;
  collectionEnabled: boolean;
  collectionLocation: string;
  deliveryRates: {
    outsideJuja: number;
    kiambu: number;
    defaultCounty: number;
    counties: Record<string, number>;
  };
}

export interface AdminDeliveryResponse {
  deliveryEnabled: boolean;
  deliveryRates: CheckoutConfigResponse['deliveryRates'];
}

export interface AdminNotificationsResponse {
  email: {
    configured: boolean;
    missingPurposes: string[];
    missing: string[];
    pending: number;
    sent7d: number;
    failed: { key: string; to: string | null; lastError: string | null }[];
  };
  telegram: { configured: boolean; missing: string[] };
}

// GET /api/products (+ /api/admin/products)
export interface ProductsResponse {
  products: Record<string, unknown>[];
}

export interface CategoriesResponse {
  categories: { id: string; name: string }[];
}

// GET /api/admin/customers
export interface AdminCustomerRow {
  uid: string; // INTERNAL identifier only — shown nowhere; name/email are used
  displayName: string | null;
  email: string | null;
  phoneNumber: string | null;
  role: string;
  createdAt: IsoDate;
  orderCount: number;
  totalSpent: number;
}

export interface AdminCustomersResponse {
  customers: AdminCustomerRow[];
}

// ---- Normalisers (shared by pages AND the contract test, so the test proves
// the exact code the UI runs). Every one tolerates BOTH the current shape and
// legacy arrays, and NEVER throws on missing data.

export function normaliseAdminOrders(raw: unknown): AdminOrderRow[] {
  if (Array.isArray(raw)) return raw as AdminOrderRow[]; // legacy shape
  const d = raw as { orders?: unknown } | null | undefined;
  return Array.isArray(d?.orders) ? (d!.orders as AdminOrderRow[]) : [];
}

export function normalisePrintpay(raw: unknown): PrintpayCallbackInfo | null {
  const d = raw as { printpay?: PrintpayCallbackInfo | null } | null | undefined;
  return d?.printpay ?? null;
}

export function normaliseDashboard(raw: unknown): DashboardResponse {
  const d = raw as Partial<DashboardResponse> | null | undefined;
  return {
    orders: Array.isArray(d?.orders) ? d!.orders! : [],
    payments: Array.isArray(d?.payments) ? d!.payments! : [],
    notifications: Array.isArray(d?.notifications) ? d!.notifications! : [],
    warnings: Array.isArray(d?.warnings) ? d!.warnings! : [],
  };
}

export function normaliseCustomers(raw: unknown): AdminCustomerRow[] {
  if (Array.isArray(raw)) return raw as AdminCustomerRow[];
  const d = raw as { customers?: unknown } | null | undefined;
  return Array.isArray(d?.customers) ? (d!.customers as AdminCustomerRow[]) : [];
}


export interface SupportAttachment { url: string; publicId: string; type: 'image'; }
export interface SupportTicketResponse { id: string; ticketId: string; subject: string; category: string; status: string; customerId: string; customerName: string; orderDocumentId: string | null; hasUnreadAdminMessages: boolean; createdAt: IsoDate; updatedAt: IsoDate; }
export interface SupportListResponse { tickets: SupportTicketResponse[]; }
