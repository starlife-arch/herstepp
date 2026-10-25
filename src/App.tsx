import React, { useEffect } from 'react';
import { BrowserRouter, Navigate, Routes, Route, useLocation } from 'react-router-dom';
import { AppProvider, useApp } from './context/AppContext';
import { Layout } from './components/Layout';
import { Toast } from './components/ui';
import ErrorBoundary from './components/ErrorBoundary';
import Home from './pages/Home';
import Shop from './pages/Shop';
import ProductDetail from './pages/ProductDetail';
import Cart from './pages/Cart';
import Checkout from './pages/Checkout';
import { Login, Register } from './pages/Auth';
import VerifyEmail from './pages/VerifyEmail';
import CustomerDashboard from './pages/CustomerDashboard';
import OrderTracking from './pages/OrderTracking';
import Support from './pages/Support';
import About from './pages/About';
import Contact from './pages/Contact';
import { PrivacyPolicy, TermsOfService } from './pages/StaticPages';
import AdminDashboard from './pages/AdminDashboard';
import AdminBulkShoeUpload from './pages/AdminBulkShoeUpload';
import AdminAIChats from './pages/AdminAIChats';
import AdminAriaFeedback from './pages/AdminAriaFeedback';
import AdminAI from './pages/AdminAI';
import AdminCosts from './pages/AdminCosts';
import TipPage from './pages/Tip';
import Wishlist from './pages/Wishlist';
import SellerApplicationPage from './pages/SellerApplication';
import AdminSellers from './pages/AdminSellers';
import AdminSellerProducts from './pages/AdminSellerProducts';
import AdminMarketplaceReports from './pages/AdminMarketplaceReports';
import AdminMarketplacePayouts from './pages/AdminMarketplacePayouts';
import AdminMarketplaceControls from './pages/AdminMarketplaceControls';
import SellerDashboard from './pages/SellerDashboard';
import SellerProfile from './pages/SellerProfile';
import SellerProducts from './pages/SellerProducts';
import SellerOrders from './pages/SellerOrders';
import PublicSellerShop from './pages/PublicSellerShop';
import MarketplaceMessages from './pages/MarketplaceMessages';

function ScrollToTop() { const { pathname } = useLocation(); useEffect(() => { window.scrollTo(0, 0); }, [pathname]); return null; }
function ToastContainer() { const { state, dispatch } = useApp(); if (!state.toast) return null; return <Toast message={state.toast.message} type={state.toast.type} onClose={() => dispatch({ type: 'SET_TOAST', payload: null })} />; }
function RequireAuth({ children }: { children: React.ReactElement }) { const { state } = useApp(); if (!state.authReady) return null; return state.user ? children : <Navigate to="/login" replace />; }
function RequireAdmin({ children }: { children: React.ReactElement }) { const { state } = useApp(); if (!state.authReady) return null; return state.user?.role === 'ADMIN' || state.user?.role === 'SUPER_ADMIN' ? children : <Navigate to="/login" replace />; }
function AppRoutes() {
 const location = useLocation();
 if (location.pathname.startsWith('/admin')) return <Routes>
  <Route path="/admin/bulk-upload" element={<Wrap><RequireAdmin><AdminBulkShoeUpload /></RequireAdmin></Wrap>} />
  <Route path="/admin/ai-chats" element={<Wrap><RequireAdmin><AdminAIChats /></RequireAdmin></Wrap>} />
  <Route path="/admin/aria-feedback" element={<Wrap><RequireAdmin><AdminAriaFeedback /></RequireAdmin></Wrap>} />
  <Route path="/admin/ai" element={<Wrap><RequireAdmin><AdminAI /></RequireAdmin></Wrap>} />
  <Route path="/admin/costs" element={<Wrap><RequireAdmin><AdminCosts /></RequireAdmin></Wrap>} />
  <Route path="/admin/sellers" element={<Wrap><RequireAdmin><AdminSellers /></RequireAdmin></Wrap>} />
  <Route path="/admin/seller-products" element={<Wrap><RequireAdmin><AdminSellerProducts /></RequireAdmin></Wrap>} />
  <Route path="/admin/marketplace-reports" element={<Wrap><RequireAdmin><AdminMarketplaceReports /></RequireAdmin></Wrap>} />
  <Route path="/admin/marketplace-payouts" element={<Wrap><RequireAdmin><AdminMarketplacePayouts /></RequireAdmin></Wrap>} />
  <Route path="/admin/marketplace-controls" element={<Wrap><RequireAdmin><AdminMarketplaceControls /></RequireAdmin></Wrap>} />
  <Route path="/admin" element={<Wrap><RequireAdmin><AdminDashboard /></RequireAdmin></Wrap>} />
  <Route path="/admin/*" element={<Wrap><RequireAdmin><AdminDashboard /></RequireAdmin></Wrap>} />
 </Routes>;
 return <Layout><Routes>
  <Route path="/" element={<Wrap><Home /></Wrap>} /><Route path="/shop" element={<Wrap><Shop /></Wrap>} />
  <Route path="/product/:id" element={<Wrap><ProductDetail /></Wrap>} /><Route path="/cart" element={<Wrap><Cart /></Wrap>} />
  <Route path="/checkout" element={<Wrap><Checkout /></Wrap>} /><Route path="/login" element={<Wrap><Login /></Wrap>} />
  <Route path="/seller/shop/:sellerId" element={<Wrap><PublicSellerShop /></Wrap>} />
  <Route path="/messages" element={<Wrap><RequireAuth><MarketplaceMessages /></RequireAuth></Wrap>} />
  <Route path="/seller/apply" element={<Wrap><RequireAuth><SellerApplicationPage /></RequireAuth></Wrap>} />
  <Route path="/seller/dashboard" element={<Wrap><RequireAuth><SellerDashboard /></RequireAuth></Wrap>} />
  <Route path="/seller/profile" element={<Wrap><RequireAuth><SellerProfile /></RequireAuth></Wrap>} />
  <Route path="/seller/products" element={<Wrap><RequireAuth><SellerProducts /></RequireAuth></Wrap>} />
  <Route path="/seller/orders" element={<Wrap><RequireAuth><SellerOrders /></RequireAuth></Wrap>} />
  <Route path="/register" element={<Wrap><Register /></Wrap>} /><Route path="/verify-email" element={<Wrap><RequireAuth><VerifyEmail /></RequireAuth></Wrap>} />
  <Route path="/wishlist" element={<Wrap><RequireAuth><Wishlist /></RequireAuth></Wrap>} /><Route path="/dashboard" element={<Wrap><RequireAuth><CustomerDashboard /></RequireAuth></Wrap>} /><Route path="/dashboard/*" element={<Wrap><RequireAuth><CustomerDashboard /></RequireAuth></Wrap>} />
  <Route path="/tip" element={<Wrap><TipPage /></Wrap>} /><Route path="/track" element={<Wrap><OrderTracking /></Wrap>} />
  <Route path="/support" element={<Wrap><Support /></Wrap>} /><Route path="/about" element={<Wrap><About /></Wrap>} />
  <Route path="/contact" element={<Wrap><Contact /></Wrap>} /><Route path="/privacy" element={<Wrap><PrivacyPolicy /></Wrap>} />
  <Route path="/terms" element={<Wrap><TermsOfService /></Wrap>} />
 </Routes></Layout>;
}
function Wrap({ children }: { children: React.ReactNode }) { return <ErrorBoundary>{children}</ErrorBoundary>; }
export default function App() { return <AppProvider><BrowserRouter><ScrollToTop /><AppRoutes /><ToastContainer /></BrowserRouter></AppProvider>; }
