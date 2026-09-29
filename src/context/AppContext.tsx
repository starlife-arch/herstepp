import React, { createContext, useContext, useEffect, useReducer, ReactNode } from 'react';
import { onAuthStateChanged, signOut } from 'firebase/auth';
import { doc, getDoc } from 'firebase/firestore';
import { getFirebase } from '../lib/firebase';
import { Product, CartItem, User, Order, Notification, SupportTicket } from '../types';
import { products as mockProducts, sampleOrders, sampleNotifications, sampleTickets } from '../data/mockData';

interface AppState {
  user: User | null;
  cart: CartItem[];
  products: Product[];
  orders: Order[];
  notifications: Notification[];
  tickets: SupportTicket[];
  toast: { message: string; type: 'success' | 'error' | 'info' } | null;
  authReady: boolean;
}

type Action =
  | { type: 'SET_USER'; payload: User | null }
  | { type: 'SET_AUTH_READY'; payload: boolean }
  | { type: 'ADD_TO_CART'; payload: CartItem }
  | { type: 'UPDATE_CART_QUANTITY'; payload: { productId: string; size: number; quantity: number } }
  | { type: 'REMOVE_FROM_CART'; payload: { productId: string; size: number } }
  | { type: 'CLEAR_CART' }
  | { type: 'ADD_ORDER'; payload: Order }
  | { type: 'UPDATE_ORDER_STATUS'; payload: { orderId: string; status: string } }
  | { type: 'SET_NOTIFICATIONS'; payload: Notification[] }
  | { type: 'MARK_NOTIFICATION_READ'; payload: string }
  | { type: 'SET_TOAST'; payload: { message: string; type: 'success' | 'error' | 'info' } | null }
  | { type: 'ADD_TICKET'; payload: SupportTicket }
  | { type: 'ADD_TICKET_MESSAGE'; payload: { ticketId: string; message: any } };

const initialState: AppState = {
  user: null,
  cart: [],
  products: mockProducts,
  orders: sampleOrders,
  notifications: sampleNotifications,
  tickets: sampleTickets,
  toast: null,
  authReady: false,
};

function appReducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case 'SET_USER':
      return { ...state, user: action.payload };
    case 'SET_AUTH_READY':
      return { ...state, authReady: action.payload };
    case 'ADD_TO_CART': {
      const existing = state.cart.find(
        i => i.product.id === action.payload.product.id && i.size === action.payload.size
      );
      if (existing) {
        return {
          ...state,
          cart: state.cart.map(i =>
            i.product.id === action.payload.product.id && i.size === action.payload.size
              ? { ...i, quantity: i.quantity + action.payload.quantity }
              : i
          ),
        };
      }
      return { ...state, cart: [...state.cart, action.payload] };
    }
    case 'UPDATE_CART_QUANTITY':
      return {
        ...state,
        cart: state.cart.map(i =>
          i.product.id === action.payload.productId && i.size === action.payload.size
            ? { ...i, quantity: action.payload.quantity }
            : i
        ),
      };
    case 'REMOVE_FROM_CART':
      return {
        ...state,
        cart: state.cart.filter(
          i => !(i.product.id === action.payload.productId && i.size === action.payload.size)
        ),
      };
    case 'CLEAR_CART':
      return { ...state, cart: [] };
    case 'ADD_ORDER':
      return { ...state, orders: [action.payload, ...state.orders] };
    case 'UPDATE_ORDER_STATUS':
      return {
        ...state,
        orders: state.orders.map(o =>
          o.orderId === action.payload.orderId
            ? { ...o, orderStatus: action.payload.status as any, updatedAt: new Date().toISOString() }
            : o
        ),
      };
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
    case 'ADD_TICKET':
      return { ...state, tickets: [action.payload, ...state.tickets] };
    case 'ADD_TICKET_MESSAGE':
      return {
        ...state,
        tickets: state.tickets.map(t =>
          t.ticketId === action.payload.ticketId
            ? { ...t, messages: [...t.messages, action.payload.message], updatedAt: new Date().toISOString() }
            : t
        ),
      };
    default:
      return state;
  }
}

const AppContext = createContext<{
  state: AppState;
  dispatch: React.Dispatch<Action>;
  logout: () => Promise<void>;
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

  useEffect(() => {
    let unsubscribe: (() => void) | undefined;
    let active = true;

    getFirebase().then(({ auth, db }) => {
      unsubscribe = onAuthStateChanged(auth, async (firebaseUser) => {
        if (!firebaseUser) {
          if (active) {
            dispatch({ type: 'SET_USER', payload: null });
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
    <AppContext.Provider value={{ state, dispatch, logout }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp() {
  const context = useContext(AppContext);
  if (!context) throw new Error('useApp must be used within AppProvider');
  return context;
}
