import React, { createContext, useContext, useEffect, useReducer, useRef, ReactNode } from 'react';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { getFirebase } from '../lib/firebase';
import { apiFetch } from '../lib/api';
import { Product, CartItem, User, Notification } from '../types';

// Persist a "read" flag on the server so refreshing does not bring old
// notifications back as unread. Best-effort: never crash the UI on failure.
export async function markNotificationReadOnServer(id: string) {
  try {
    await apiFetch(`/api/notifications/${encodeURIComponent(id)}`, { method: 'PATCH' });
  } catch {
    /* ignore — local state already updated */
  }
}

export interface ServerOrder {
  id: string;
  orderId?: string;
  customerId?: string;
  customerEmail?: string;
  items?: any[];
  subtotal?: number;
  deliveryFee?: number;
  discount?: number;
  total?: number;
  currency?: string;
  paymentStatus?: string;
  orderStatus?: string;
  delivery?: any;
  createdAt?: string | null;
  updatedAt?: string | null;
  [key: string]: unknown;
}

export interface ServerPayment {
  id: string;
  orderId?: string;
  amount?: number;
  currency?: string;
  method?: string;
  status?: string;
  receiptNumber?: string | null;
  transactionReference?: string | null;
  failureReason?: string | null;
  createdAt?: string | null;
  [key: string]: unknown;
}

interface AppState {
  user: User | null;
  cart: CartItem[];
  products: Product[];
  categories: { id: string; name: string }[];
  notifications: Notification[];
  // Real server data (GET /api/dashboard). Never mock data. Safe defaults keep pages from crashing.
  orders: ServerOrder[];
  payments: ServerPayment[];
  dashboardLoading: boolean;
  dashboardError: string | null;
  dashboardWarnings: DashboardWarning[];
  toast: { message: string; type: 'success' | 'error' | 'info' } | null;
  authReady: boolean;
  catalogLoading: boolean;
  catalogError: string | null;
}

// The dashboard API returns warnings either as plain strings or as objects
// { section, reason }. Normalise to readable text at the edge.
export type DashboardWarning = string;
type DashboardWarningInput = string | { section?: string; reason?: string };

const friendlyWarningReason = (reason: string): string => {
  const r = reason.toLowerCase();
  if (r.includes('resource_exhausted') || r.includes('quota')) {
    return 'The shop is very busy right now. Please try again in a few minutes.';
  }
  if (r.includes('index') || r.includes('indexes')) {
    return 'Setting up your account data, try again shortly.';
  }
  return reason;
};

export const normalizeDashboardWarnings = (list: unknown): DashboardWarning[] => {
  if (!Array.isArray(list)) return [];
  return list.map((w: DashboardWarningInput) => {
    if (typeof w === 'string') return friendlyWarningReason(w);
    if (w && typeof w === 'object') {
      const section = String(w.section ?? '').trim();
      const reason = friendlyWarningReason(String(w.reason ?? '').trim());
      return section ? `${section}: ${reason}` : reason;
    }
    return String(w);
  }).filter(Boolean);
};

type Action =
  | { type: 'SET_USER'; payload: User | null }
  | { type: 'SET_AUTH_READY'; payload: boolean }
  | { type: 'SET_CATALOG'; payload: { products: Product[]; categories: { id: string; name: string }[] } }
  | { type: 'SET_CATALOG_STATUS'; payload: { loading: boolean; error: string | null } }
  | { type: 'SET_DASHBOARD'; payload: { orders: ServerOrder[]; payments: ServerPayment[]; notifications: Notification[]; warnings?: DashboardWarningInput[] } }
  | { type: 'SET_DASHBOARD_STATUS'; payload: { loading: boolean; error: string | null } }
  | { type: 'ADD_TO_CART'; payload: CartItem }
  | { type: 'UPDATE_CART_QUANTITY'; payload: { productId: string; size: string; quantity: number } }
  | { type: 'REMOVE_FROM_CART'; payload: { productId: string; size: string } }
  | { type: 'CLEAR_CART' }
  | { type: 'SET_NOTIFICATIONS'; payload: Notification[] }
  | { type: 'MARK_NOTIFICATION_READ'; payload: string }
  | { type: 'SET_TOAST'; payload: { message: string; type: 'success' | 'error' | 'info' } | null };

// Bumped to v3: v2 could still hold carts built from mock product ids that do not exist in Firestore.
const CART_STORAGE_KEY = 'herstep-cart-v3';
try {
  localStorage.removeItem('herstep-cart');
  localStorage.removeItem('herstep-cart-v2');
} catch {
  /* storage unavailable */
}

function readStoredCart(products: Product[]): CartItem[] {
  try {
    const raw = localStorage.getItem(CART_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    // Only keep entries whose product still exists in the live catalogue and whose size is still stocked.
    return parsed.filter((item: any) => {
      const product = products.find(p => p.id === item?.product?.id);
      if (!product || product.status !== 'ACTIVE') return false;
      return Array.isArray(product.inventory) && product.inventory.some(i => i.size === item.size && i.quantity > 0);
    }) as CartItem[];
  } catch {
    return [];
  }
}

// Sale prices are integer KES or null. Anything that is not a positive integer
// lower than the list price counts as "no sale" (mirrors unitPrice() in api/_lib/order-core.js).
export function normaliseSalePrice(salePrice: unknown, price: number): number | null {
  const sale = Number(salePrice);
  return Number.isInteger(sale) && sale > 0 && sale < price ? sale : null;
}

// The single effective-price rule used by every page (Home, Shop, ProductDetail,
// Cart, Checkout, Admin): the sale price only applies when it is a positive
// integer lower than the list price; otherwise the list price is shown.
export function effectivePrice(p: { price: number; salePrice?: number | null }): number {
  return p.salePrice != null && p.salePrice > 0 && p.salePrice < p.price ? p.salePrice : p.price;
}

// True only when the product genuinely has a discounted price — controls the
// sale badge and the struck-through list price everywhere.
export function hasDiscount(p: { price: number; salePrice?: number | null }): boolean {
  return p.salePrice != null && p.salePrice > 0 && p.salePrice < p.price;
}

// Never assume Firestore array shapes: a damaged product (inventory/images/availableSizes stored
// as an object instead of an array) must not crash the storefront.
export function normaliseProduct(raw: any): Product | null {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || !raw.id) return null;
  const inventory = Array.isArray(raw.inventory)
    ? raw.inventory.filter((i: any) => i && typeof i.size === 'string' && Number.isFinite(Number(i.quantity)))
        .map((i: any) => ({ size: i.size, quantity: Math.max(0, Math.trunc(Number(i.quantity))) }))
    : [];
  const images = Array.isArray(raw.images)
    ? raw.images.filter((img: any) => img && typeof img.url === 'string')
    : [];
  const availableSizes = Array.isArray(raw.availableSizes) ? raw.availableSizes.filter((s: any) => typeof s === 'string') : [];
  return {
    ...raw,
    inventory,
    images,
    video: raw.video && typeof raw.video.url === 'string' ? raw.video : null,
    availableSizes,
    price: Number.isFinite(Number(raw.price)) ? Number(raw.price) : 0,
    // NOTE: Number(null) === 0, so a bare isFinite check would turn a missing
    // sale price into 0 and make every product show "KSh 0". salePrice stays
    // null unless raw.salePrice is a POSITIVE INTEGER strictly lower than price.
    salePrice: normaliseSalePrice(raw.salePrice, Number.isFinite(Number(raw.price)) ? Number(raw.price) : 0),
    stockQuantity: Number.isFinite(Number(raw.stockQuantity)) ? Number(raw.stockQuantity) : inventory.reduce((n: number, i: { quantity: number }) => n + i.quantity, 0),
    status: raw.status === 'ACTIVE' || raw.status === 'DRAFT' || raw.status === 'ARCHIVED' ? raw.status : 'DRAFT',
    featured: Boolean(raw.featured),
    bestseller: Boolean(raw.bestseller),
    newArrival: Boolean(raw.newArrival),
    name: typeof raw.name === 'string' ? raw.name : 'Unnamed product',
    description: typeof raw.description === 'string' ? raw.description : '',
    categoryId: typeof raw.categoryId === 'string' ? raw.categoryId : '',
    sku: typeof raw.sku === 'string' ? raw.sku : '',
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : new Date().toISOString(),
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
  };
}

export function mapNotification(n: any): Notification {
  return {
    id: String(n?.id ?? ''),
    userId: typeof n?.customerId === 'string' ? n.customerId : '',
    title: typeof n?.title === 'string' ? n.title : 'Update',
    message: typeof n?.body === 'string' ? n.body : '',
    type: 'order',
    read: Boolean(n?.readAt),
    createdAt: n?.createdAt || new Date().toISOString(),
    link: n?.orderDocumentId ? `/track?orderDocumentId=${encodeURIComponent(n.orderDocumentId)}` : undefined,
  };
}

const initialState: AppState = {
  user: null,
  cart: [],
  products: [],
  categories: [],
  notifications: [],
  orders: [],
  payments: [],
  dashboardLoading: false,
  dashboardError: null,
  dashboardWarnings: [],
  toast: null,
  authReady: false,
  catalogLoading: true,
  catalogError: null,
};

function clampQuantity(item: CartItem): CartItem {
  const stock = item.product.inventory.find(s => s.size === item.size)?.quantity ?? 0;
  return { ...item, quantity: Math.max(1, Math.min(item.quantity, Math.max(stock, 1))) };
}

function appReducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'SET_USER':
      return { ...state, user: action.payload };
    case 'SET_AUTH_READY':
      return { ...state, authReady: action.payload };
    case 'SET_CATALOG': {
      const knownIds = new Set(action.payload.products.map(p => p.id));
      const stored = readStoredCart(action.payload.products);
      const merged = state.cart.length > 0 ? state.cart.filter(i => knownIds.has(i.product.id)).map(clampQuantity) : stored;
      return { ...state, products: action.payload.products, categories: action.payload.categories, cart: merged, catalogLoading: false, catalogError: null };
    }
    case 'SET_CATALOG_STATUS':
      return { ...state, catalogLoading: action.payload.loading, catalogError: action.payload.error };
    case 'SET_DASHBOARD':
      return {
        ...state,
        orders: Array.isArray(action.payload.orders) ? action.payload.orders : [],
        payments: Array.isArray(action.payload.payments) ? action.payload.payments : [],
        notifications: Array.isArray(action.payload.notifications) ? action.payload.notifications : [],
        dashboardLoading: false,
        dashboardError: null,
        dashboardWarnings: normalizeDashboardWarnings(action.payload.warnings),
      };
    case 'SET_DASHBOARD_STATUS':
      return { ...state, dashboardLoading: action.payload.loading, dashboardError: action.payload.error };
    case 'ADD_TO_CART': {
      const payload = clampQuantity(action.payload);
      const existing = state.cart.find(i => i.product.id === payload.product.id && i.size === payload.size);
      if (existing) {
        const stock = payload.product.inventory.find(s => s.size === payload.size)?.quantity ?? 0;
        return {
          ...state,
          cart: state.cart.map(i =>
            i.product.id === payload.product.id && i.size === payload.size
              ? { ...i, quantity: Math.min(i.quantity + payload.quantity, stock) }
              : i
          ),
        };
      }
      return { ...state, cart: [...state.cart, payload] };
    }
    case 'UPDATE_CART_QUANTITY': {
      const item = state.cart.find(i => i.product.id === action.payload.productId && i.size === action.payload.size);
      const stock = item?.product.inventory.find(s => s.size === item.size)?.quantity ?? 0;
      const quantity = Math.max(1, Math.min(action.payload.quantity, Math.max(stock, 1)));
      return {
        ...state,
        cart: state.cart.map(i =>
          i.product.id === action.payload.productId && i.size === action.payload.size
            ? { ...i, quantity }
            : i
        ),
      };
    }
    case 'REMOVE_FROM_CART':
      return {
        ...state,
        cart: state.cart.filter(
          i => !(i.product.id === action.payload.productId && i.size === action.payload.size)
        ),
      };
    case 'CLEAR_CART':
      return { ...state, cart: [] };
    case 'SET_NOTIFICATIONS':
      return { ...state, notifications: action.payload };
    case 'MARK_NOTIFICATION_READ':
      return {
        ...state,
        notifications: state.notifications.map(n =>
          n.id === action.payload ? { ...n, read: true } : n
        ),
      };
    case 'SET_TOAST':
      return { ...state, toast: action.payload };
    default:
      return state;
  }
}

const AppContext = createContext<{
  state: AppState;
  dispatch: React.Dispatch<Action>;
  logout: () => Promise<void>;
  reloadCatalog: () => Promise<void>;
  reloadDashboard: () => Promise<void>;
} | null>(null);

function timestampToIso(value: unknown) {
  if (value && typeof value === 'object' && 'toDate' in value && typeof value.toDate === 'function') {
    return value.toDate().toISOString();
  }
  return new Date().toISOString();
}

function isRole(value: unknown): value is User['role'] {
  return value === 'CUSTOMER' || value === 'ADMIN' || value === 'SUPER_ADMIN';
}

export function AppProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(appReducer, initialState);
  const stateRef = useRef(state);
  stateRef.current = state;

  // Load the real catalogue from the server (public endpoints, no sample data).
  // Products whose inventory/images/availableSizes are not arrays (damaged docs) are dropped here
  // so a bad document can never crash a page; the API logs their ids for repair.
  const loadCatalog = async () => {
    dispatch({ type: 'SET_CATALOG_STATUS', payload: { loading: true, error: null } });
    try {
      const [rawProducts, categories] = await Promise.all([
        apiFetch('/api/products') as Promise<any[]>,
        apiFetch('/api/categories') as Promise<{ id: string; name: string }[]>,
      ]);
      const products = (Array.isArray(rawProducts) ? rawProducts : [])
        .map(normaliseProduct)
        .filter((p): p is Product => p !== null);
      dispatch({ type: 'SET_CATALOG', payload: { products, categories: Array.isArray(categories) ? categories : [] } });
    } catch (error) {
      const raw = error instanceof Error ? error.message : 'We could not load the catalogue.';
      // Friendly copy on public pages: never show raw server/Firestore errors.
      const friendly = /resource_exhausted|quota|500|503|unavailable|Failed to fetch|NetworkError|fetch/i.test(raw)
        ? 'The shop is busy, please try again in a minute.'
        : raw;
      dispatch({ type: 'SET_CATALOG_STATUS', payload: { loading: false, error: friendly } });
    }
  };

  // Real customer dashboard data (GET /api/dashboard) — orders, payments and notifications.
  // IMPORTANT: this must NOT read stateRef.current.user — the auth listener calls it in the
  // same tick it dispatches SET_USER, and stateRef only updates on the NEXT render. That race
  // used to dispatch empty arrays and never hit the server ("My Orders always empty").
  // Pass the uid explicitly when known; otherwise fall back to Firebase auth.currentUser.
  const loadDashboard = async (uidHint?: string | null) => {
    let uid = uidHint ?? null;
    if (!uid) {
      try {
        const { auth } = await getFirebase();
        uid = auth.currentUser?.uid ?? null;
      } catch {
        uid = null;
      }
    }
    if (!uid) {
      dispatch({ type: 'SET_DASHBOARD', payload: { orders: [], payments: [], notifications: [] } });
      return;
    }
    dispatch({ type: 'SET_DASHBOARD_STATUS', payload: { loading: true, error: null } });
    try {
      const data = await apiFetch('/api/dashboard') as any;
      dispatch({
        type: 'SET_DASHBOARD',
        payload: {
          orders: Array.isArray(data?.orders) ? data.orders : [],
          payments: Array.isArray(data?.payments) ? data.payments : [],
          notifications: Array.isArray(data?.notifications) ? data.notifications.map(mapNotification) : [],
          warnings: Array.isArray(data?.warnings) ? data.warnings : [],
        },
      });
    } catch (error) {
      // Never silently show "No orders yet" on failure: keep the server message visible.
      dispatch({ type: 'SET_DASHBOARD_STATUS', payload: { loading: false, error: error instanceof Error ? error.message : 'We could not load your account.' } });
    }
  };

  useEffect(() => {
    void loadCatalog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Persist the cart under the versioned key only once the catalogue has loaded,
  // so stale entries (mock ids) are never written back.
  useEffect(() => {
    if (state.catalogLoading || state.catalogError) return;
    try {
      localStorage.setItem(CART_STORAGE_KEY, JSON.stringify(state.cart));
    } catch {
      /* storage unavailable */
    }
  }, [state.cart, state.catalogLoading, state.catalogError]);

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let active = true;

    getFirebase().then(({ auth, db }) => {
      unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
        if (!firebaseUser) {
          if (active) {
            dispatch({ type: 'SET_USER', payload: null });
            dispatch({ type: 'SET_NOTIFICATIONS', payload: [] });
            dispatch({ type: 'SET_AUTH_READY', payload: true });
          }
          return;
        }

        try {
          let profile = await getDoc(doc(db, 'users', firebaseUser.uid));
          for (let attempt = 0; !profile.exists() && attempt < 8; attempt += 1) {
            await new Promise(resolve => setTimeout(resolve, 500));
            profile = await getDoc(doc(db, 'users', firebaseUser.uid));
          }
          if (!profile.exists()) throw new Error('Profile not found.');
          const data = profile.data();
          if (!isRole(data.role)) throw new Error('Profile has an invalid role.');
          if (active) {
            dispatch({
              type: 'SET_USER',
              payload: {
                id: firebaseUser.uid,
                name: typeof data.displayName === 'string' ? data.displayName : firebaseUser.displayName || '',
                email: typeof data.email === 'string' ? data.email : firebaseUser.email || '',
                phone: typeof data.phoneNumber === 'string' ? data.phoneNumber : '',
                role: data.role,
                createdAt: timestampToIso(data.createdAt),
                deliveryAddress: typeof data.deliveryDetails === 'string' ? data.deliveryDetails : undefined,
              },
            });
          }
          // Real orders, payments and notifications (GET /api/dashboard). Pass the uid we just
          // verified — loadDashboard must not read stateRef (it updates only on the next render).
          void loadDashboard(firebaseUser.uid);
        } catch {
          if (active) dispatch({ type: 'SET_USER', payload: null });
        } finally {
          if (active) dispatch({ type: 'SET_AUTH_READY', payload: true });
        }
      });
    }).catch(() => {
      if (active) dispatch({ type: 'SET_AUTH_READY', payload: true });
    });

    return () => {
      active = false;
      unsubscribe?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const logout = async () => {
    const { auth } = await getFirebase();
    await signOut(auth);
    dispatch({ type: 'SET_DASHBOARD', payload: { orders: [], payments: [], notifications: [] } });
  };

  return (
    <AppContext.Provider value={{ state, dispatch, logout, reloadCatalog: loadCatalog, reloadDashboard: loadDashboard }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const context = useContext(AppContext);
  if (!context) throw new Error('useApp must be used within AppProvider');
  return context;
}
