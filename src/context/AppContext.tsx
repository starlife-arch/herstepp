import React, { createContext, useContext, useEffect, useReducer, useRef, ReactNode } from 'react';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { getFirebase } from '../lib/firebase';
import { apiFetch } from '../lib/api';
import { Product, CartItem, User, Notification } from '../types';

interface AppState {
  user: User | null;
  cart: CartItem[];
  products: Product[];
  categories: { id: string; name: string }[];
  notifications: Notification[];
  toast: { message: string; type: 'success' | 'error' | 'info' } | null;
  authReady: boolean;
  catalogLoading: boolean;
  catalogError: string | null;
}

type Action =
  | { type: 'SET_USER'; payload: User | null }
  | { type: 'SET_AUTH_READY'; payload: boolean }
  | { type: 'SET_CATALOG'; payload: { products: Product[]; categories: { id: string; name: string }[] } }
  | { type: 'SET_CATALOG_STATUS'; payload: { loading: boolean; error: string | null } }
  | { type: 'ADD_TO_CART'; payload: CartItem }
  | { type: 'UPDATE_CART_QUANTITY'; payload: { productId: string; size: string; quantity: number } }
  | { type: 'REMOVE_FROM_CART'; payload: { productId: string; size: string } }
  | { type: 'CLEAR_CART' }
  | { type: 'SET_NOTIFICATIONS'; payload: Notification[] }
  | { type: 'MARK_NOTIFICATION_READ'; payload: string }
  | { type: 'SET_TOAST'; payload: { message: string; type: 'success' | 'error' | 'info' } | null };

// Bumped to v2: the old key held carts built from mock product ids that do not exist in Firestore.
const CART_STORAGE_KEY = 'herstep-cart-v2';

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
      return product.inventory.some(i => i.size === item.size && i.quantity > 0);
    }) as CartItem[];
  } catch {
    return [];
  }
}

const initialState: AppState = {
  user: null,
  cart: [],
  products: [],
  categories: [],
  notifications: [],
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
  const loadCatalog = async () => {
    dispatch({ type: 'SET_CATALOG_STATUS', payload: { loading: true, error: null } });
    try {
      const [products, categories] = await Promise.all([
        apiFetch('/api/products') as Promise<Product[]>,
        apiFetch('/api/categories') as Promise<{ id: string; name: string }[]>,
      ]);
      dispatch({ type: 'SET_CATALOG', payload: { products: Array.isArray(products) ? products : [], categories: Array.isArray(categories) ? categories : [] } });
    } catch (error) {
      dispatch({ type: 'SET_CATALOG_STATUS', payload: { loading: false, error: error instanceof Error ? error.message : 'We could not load the catalogue.' } });
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
          const profile = await getDoc(doc(db, 'users', firebaseUser.uid));
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
          // Real notifications only (GET /api/notifications).
          try {
            const rows = await apiFetch('/api/notifications') as any[];
            if (active && Array.isArray(rows)) {
              dispatch({
                type: 'SET_NOTIFICATIONS',
                payload: rows.map(n => ({
                  id: n.id,
                  userId: n.customerId,
                  title: typeof n.title === 'string' ? n.title : 'Update',
                  message: typeof n.body === 'string' ? n.body : '',
                  type: 'order',
                  read: Boolean(n.readAt),
                  createdAt: n.createdAt || new Date().toISOString(),
                  link: n.orderDocumentId ? `/track?orderDocumentId=${n.orderDocumentId}` : undefined,
                })),
              });
            }
          } catch {
            if (active) dispatch({ type: 'SET_NOTIFICATIONS', payload: [] });
          }
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
  }, []);

  const logout = async () => {
    const { auth } = await getFirebase();
    await signOut(auth);
  };

  return (
    <AppContext.Provider value={{ state, dispatch, logout, reloadCatalog: loadCatalog }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const context = useContext(AppContext);
  if (!context) throw new Error('useApp must be used within AppProvider');
  return context;
}
