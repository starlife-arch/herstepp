import React, { useEffect } from 'react';
import { BrowserRouter, Navigate, Routes, Route, useLocation } from 'react-router-dom';
import { AppProvider, useApp } from './context/AppContext';
import { Layout } from './components/Layout';
import { Toast } from './components/ui';

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
        <Route path="/admin" element={<RequireAdmin><AdminDashboard /></RequireAdmin>} />
        <Route path="/admin/*" element={<RequireAdmin><AdminDashboard /></RequireAdmin>} />
      </Routes>
    );
  }

  return (
    <Layout>
      <Routes>
        <Route path="/" element={<Home />} />
        <Route path="/shop" element={<Shop />} />
        <Route path="/product/:slug" element={<ProductDetail />} />
        <Route path="/cart" element={<Cart />} />
        <Route path="/checkout" element={<Checkout />} />
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route path="/dashboard" element={<RequireAuth><CustomerDashboard /></RequireAuth>} />
        <Route path="/dashboard/*" element={<RequireAuth><CustomerDashboard /></RequireAuth>} />
        <Route path="/track" element={<OrderTracking />} />
        <Route path="/support" element={<Support />} />
        <Route path="/about" element={<About />} />
        <Route path="/contact" element={<Contact />} />
        <Route path="/privacy" element={<PrivacyPolicy />} />
        <Route path="/terms" element={<TermsOfService />} />
      </Routes>
    </Layout>
  );
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
