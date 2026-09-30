import React, { useEffect } from 'react';
import { BrowserRouter, Navigate, Routes, Route, useLocation } from 'react-router-dom';
import { AppProvider, useApp } from './context/AppContext';
import { Layout } from './components/Layout';
import { Toast } from './components/ui';
import ErrorBoundary from './components/ErrorBoundary';

// Pages
import Home from './pages/Home';
import Shop from './pages/Shop';
import ProductDetail from './pages/ProductDetail';
import Cart from './pages/Cart';
import Checkout from './pages/Checkout';
import { Login, Register } from './pages/Auth';
import CustomerDashboard from './pages/CustomerDashboard';
import OrderTracking from './pages/OrderTracking';
import Support from './pages/Support';
import About from './pages/About';
import Contact from './pages/Contact';
import { PrivacyPolicy, TermsOfService } from './pages/StaticPages';
import AdminDashboard from './pages/AdminDashboard';

function ScrollToTop() {
  const { pathname } = useLocation();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  return null;
}

function ToastContainer() {
  const { state, dispatch } = useApp();
  if (!state.toast) return null;
  return (
    <Toast
      message={state.toast.message}
      type={state.toast.type}
      onClose={() => dispatch({ type: 'SET_TOAST', payload: null })}
    />
  );
}


function RequireAuth({ children }: { children: React.ReactElement }) {
  const { state } = useApp();
  if (!state.authReady) return null;
  return state.user ? children : <Navigate to="/login" replace />;
}

function RequireAdmin({ children }: { children: React.ReactElement }) {
  const { state } = useApp();
  if (!state.authReady) return null;
  return state.user?.role === 'ADMIN' || state.user?.role === 'SUPER_ADMIN'
    ? children
    : <Navigate to="/login" replace />;
}

function AppRoutes() {
  const location = useLocation();
  const isAdmin = location.pathname.startsWith('/admin');

  if (isAdmin) {
    return (
      <Routes>
        <Route path="/admin" element={<Wrap><RequireAdmin><AdminDashboard /></RequireAdmin></Wrap>} />
        <Route path="/admin/*" element={<Wrap><RequireAdmin><AdminDashboard /></RequireAdmin></Wrap>} />
      </Routes>
    );
  }

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Wrap><Home /></Wrap>} />
        <Route path="/shop" element={<Wrap><Shop /></Wrap>} />
        <Route path="/product/:id" element={<Wrap><ProductDetail /></Wrap>} />
        <Route path="/cart" element={<Wrap><Cart /></Wrap>} />
        <Route path="/checkout" element={<Wrap><Checkout /></Wrap>} />
        <Route path="/login" element={<Wrap><Login /></Wrap>} />
        <Route path="/register" element={<Wrap><Register /></Wrap>} />
        <Route path="/dashboard" element={<Wrap><RequireAuth><CustomerDashboard /></RequireAuth></Wrap>} />
        <Route path="/dashboard/*" element={<Wrap><RequireAuth><CustomerDashboard /></RequireAuth></Wrap>} />
        <Route path="/track" element={<Wrap><OrderTracking /></Wrap>} />
        <Route path="/support" element={<Wrap><Support /></Wrap>} />
        <Route path="/about" element={<Wrap><About /></Wrap>} />
        <Route path="/contact" element={<Wrap><Contact /></Wrap>} />
        <Route path="/privacy" element={<Wrap><PrivacyPolicy /></Wrap>} />
        <Route path="/terms" element={<Wrap><TermsOfService /></Wrap>} />
      </Routes>
    </Layout>
  );
}

// Each route is wrapped in its own boundary, so one broken page shows a
// friendly message instead of white-screening the whole app.
function Wrap({ children }: { children: React.ReactNode }) {
  return <ErrorBoundary>{children}</ErrorBoundary>;
}

export default function App() {
  return (
    <AppProvider>
      <BrowserRouter>
        <ScrollToTop />
        <AppRoutes />
        <ToastContainer />
      </BrowserRouter>
    </AppProvider>
  );
}
