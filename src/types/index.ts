export interface Product {
  id: string;
  name: string;
  slug: string;
  description: string;
  category: string;
  sku: string;
  price: number;
  salePrice?: number;
  images: string[];
  video?: string;
  sizes: SizeInventory[];
  status: 'active' | 'draft' | 'archived';
  isFeatured: boolean;
  isBestseller: boolean;
  isNewArrival: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface SizeInventory {
  size: number;
  quantity: number;
}

export interface Category {
  id: string;
  name: string;
  slug: string;
  productCount: number;
}

export interface CartItem {
  product: Product;
  size: number;
  quantity: number;
}

export interface User {
  id: string;
  name: string;
  email: string;
  phone: string;
  role: 'customer' | 'admin' | 'super_admin';
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
