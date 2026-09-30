// Mirrors the Firestore products/{id} contract in AGENTS.md (written by /api, read-only in the browser).
export interface Product {
  id: string;                 // real Firestore document id (used in /product/:id)
  name: string;
  description: string;
  categoryId: string;
  sku: string;                // UPPERCASE
  price: number;              // integer KES
  salePrice: number | null;   // integer KES or null, always < price
  inventory: SizeInventory[]; // every size from "30".."45", unique strings
  images: ProductImage[];     // 1 to 8
  video: ProductVideo | null;
  status: 'DRAFT' | 'ACTIVE' | 'ARCHIVED';
  featured: boolean;
  bestseller: boolean;
  newArrival: boolean;
  stockQuantity: number;      // derived, server-written
  availableSizes: string[];   // derived, server-written (sizes with quantity > 0)
  createdAt: string;
  updatedAt: string;
}

export interface SizeInventory {
  size: string;   // "30".."45"
  quantity: number;
}

export interface ProductImage {
  url: string;
  publicId: string;
  resourceType: 'image';
}

export interface ProductVideo {
  url: string;
  publicId: string;
  resourceType: 'video';
}

export interface Category {
  id: string;
  name: string;
}

export interface CartItem {
  product: Product;
  size: string;   // matches products.inventory[].size
  quantity: number;
}

export interface User {
  id: string;
  name: string;
  email: string;
  phone: string;
  role: 'CUSTOMER' | 'ADMIN' | 'SUPER_ADMIN';
  createdAt: string;
  deliveryAddress?: string;
}

export interface Order {
  id: string;
  orderId: string;
  customerId: string;
  customerName: string;
  customerPhone: string;
  customerEmail: string;
  items: OrderItem[];
  subtotal: number;
  deliveryFee: number;
  discount: number;
  total: number;
  deliveryMethod: 'collection' | 'delivery';
  deliveryLocation: string;
  deliveryInstructions?: string;
  paymentStatus: PaymentStatus;
  orderStatus: OrderStatus;
  statusHistory: StatusHistoryEntry[];
  promoCode?: string;
  createdAt: string;
  updatedAt: string;
}

export interface OrderItem {
  productId: string;
  productName: string;
  productImage: string;
  size: number;
  quantity: number;
  unitPrice: number;
  total: number;
}

export interface StatusHistoryEntry {
  previousStatus: string;
  newStatus: string;
  timestamp: string;
  note?: string;
}

export type PaymentStatus = 'pending' | 'paid' | 'failed' | 'cancelled' | 'timeout' | 'refunded';
export type OrderStatus = 'pending' | 'processing' | 'processed' | 'out_for_delivery' | 'delivered' | 'cancelled';

export interface Payment {
  id: string;
  orderId: string;
  customerId: string;
  amount: number;
  phone: string;
  method: string;
  providerRef?: string;
  transactionRef?: string;
  status: PaymentStatus;
  createdAt: string;
  failureReason?: string;
}

export interface SupportTicket {
  id: string;
  ticketId: string;
  customerId: string;
  customerName: string;
  subject: string;
  category: string;
  status: 'open' | 'in_progress' | 'waiting_customer' | 'resolved' | 'closed';
  messages: SupportMessage[];
  createdAt: string;
  updatedAt: string;
}

export interface SupportMessage {
  id: string;
  senderId: string;
  senderName: string;
  senderRole: 'customer' | 'admin';
  content: string;
  attachments?: { url: string; type: string }[];
  timestamp: string;
  isInternal?: boolean;
}

export interface Notification {
  id: string;
  userId: string;
  title: string;
  message: string;
  type: 'order' | 'payment' | 'support' | 'promotion' | 'system';
  read: boolean;
  createdAt: string;
  link?: string;
}

export interface Promotion {
  id: string;
  name: string;
  description: string;
  type: 'percentage' | 'fixed' | 'product_sale';
  discountValue: number;
  promoCode?: string;
  startDate: string;
  endDate: string;
  minOrder?: number;
  maxUsage?: number;
  currentUsage: number;
  active: boolean;
}

export interface DiscountRequest {
  id: string;
  customerId: string;
  customerName: string;
  type: 'discount' | 'bulk_order' | 'specific_shoe' | 'restock' | 'special_offer';
  products?: string[];
  quantity?: number;
  proposedPrice?: number;
  message: string;
  status: 'pending' | 'reviewing' | 'offer_sent' | 'accepted' | 'declined' | 'closed';
  adminResponse?: string;
  createdAt: string;
}
