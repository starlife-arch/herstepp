import React, { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ShoppingBag, Menu, X, User, Search, Heart, ChevronDown } from 'lucide-react';
import { useApp } from '../context/AppContext';

export function Header() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const { state } = useApp();
  const location = useLocation();
  const cartCount = state.cart.reduce((sum, i) => sum + i.quantity, 0);

  const navLinks = [
    { to: '/', label: 'Home' },
    { to: '/shop', label: 'Shop' },
    { to: '/track', label: 'Track Order' },
    { to: '/support', label: 'Support' },
    { to: '/contact', label: 'Contact' },
  ];

  return (
    <header className="sticky top-0 z-40 bg-white/95 backdrop-blur-md border-b border-neutral-200">
      <div className="max-w-7xl mx-auto px-4 sm:px-6">
        <div className="flex items-center justify-between h-16">
          {/* Logo */}
          <Link to="/" className="flex items-center gap-2">
            <div className="w-8 h-8 bg-neutral-900 rounded-lg flex items-center justify-center">
              <span className="text-white font-bold text-sm">H</span>
            </div>
            <div className="hidden sm:block">
              <span className="font-semibold text-neutral-900 text-lg tracking-tight">HerStep</span>
              <span className="text-neutral-400 text-xs block -mt-1 font-medium">Collection</span>
            </div>
          </Link>

          {/* Desktop Nav */}
          <nav className="hidden md:flex items-center gap-8">
            {navLinks.map(link => (
              <Link
                key={link.to}
                to={link.to}
                className={`text-sm font-medium transition-colors ${location.pathname === link.to ? 'text-neutral-900' : 'text-neutral-500 hover:text-neutral-900'}`}
              >
                {link.label}
              </Link>
            ))}
          </nav>

          {/* Right Actions */}
          <div className="flex items-center gap-3">
            <Link to="/shop" className="p-2 rounded-lg hover:bg-neutral-100 transition-colors hidden sm:flex">
              <Search className="w-5 h-5 text-neutral-600" />
            </Link>
            <Link to={state.user ? '/dashboard' : '/login'} className="p-2 rounded-lg hover:bg-neutral-100 transition-colors">
              <User className="w-5 h-5 text-neutral-600" />
            </Link>
            <Link to="/cart" className="relative p-2 rounded-lg hover:bg-neutral-100 transition-colors">
              <ShoppingBag className="w-5 h-5 text-neutral-600" />
              {cartCount > 0 && (
                <span className="absolute -top-0.5 -right-0.5 w-5 h-5 bg-neutral-900 text-white text-xs rounded-full flex items-center justify-center font-medium">
                  {cartCount}
                </span>
              )}
            </Link>
            <button onClick={() => setMobileOpen(!mobileOpen)} className="p-2 rounded-lg hover:bg-neutral-100 md:hidden">
              {mobileOpen ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
            </button>
          </div>
        </div>
      </div>

      {/* Mobile Nav */}
      {mobileOpen && (
        <div className="md:hidden border-t border-neutral-200 bg-white animate-fadeIn">
          <nav className="px-4 py-4 space-y-1">
            {navLinks.map(link => (
              <Link
                key={link.to}
                to={link.to}
                onClick={() => setMobileOpen(false)}
                className={`block px-3 py-2.5 rounded-lg text-sm font-medium ${location.pathname === link.to ? 'bg-neutral-100 text-neutral-900' : 'text-neutral-600 hover:bg-neutral-50'}`}
              >
                {link.label}
              </Link>
            ))}
            <hr className="my-2 border-neutral-100" />
            <Link to={state.user ? '/dashboard' : '/login'} onClick={() => setMobileOpen(false)} className="block px-3 py-2.5 rounded-lg text-sm font-medium text-neutral-600 hover:bg-neutral-50">
              {state.user ? 'My Account' : 'Login / Register'}
            </Link>
          </nav>
        </div>
      )}
    </header>
  );
}

export function Footer() {
  return (
    <footer className="bg-neutral-900 text-white mt-auto">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-12">
        <div className="grid grid-cols-1 md:grid-cols-4 gap-8">
          {/* Brand */}
          <div className="md:col-span-1">
            <div className="flex items-center gap-2 mb-4">
              <div className="w-8 h-8 bg-white rounded-lg flex items-center justify-center">
                <span className="text-neutral-900 font-bold text-sm">H</span>
              </div>
              <div>
                <span className="font-semibold text-lg">HerStep</span>
                <span className="text-neutral-400 text-xs block -mt-1">Collection</span>
              </div>
            </div>
            <p className="text-neutral-400 text-sm leading-relaxed">
              Step Into Your Style. Premium ladies' footwear in Juja Town.
            </p>
          </div>

          {/* Quick Links */}
          <div>
            <h4 className="font-semibold text-sm mb-4">Shop</h4>
            <ul className="space-y-2.5">
              {['Summer Sandals', 'Platform Shoes', 'Block Heels', 'Stiletto Heels', 'Flats'].map(item => (
                <li key={item}><Link to="/shop" className="text-neutral-400 text-sm hover:text-white transition-colors">{item}</Link></li>
              ))}
            </ul>
          </div>

          {/* Support */}
          <div>
            <h4 className="font-semibold text-sm mb-4">Support</h4>
            <ul className="space-y-2.5">
              <li><Link to="/track" className="text-neutral-400 text-sm hover:text-white transition-colors">Track Order</Link></li>
              <li><Link to="/support" className="text-neutral-400 text-sm hover:text-white transition-colors">Contact Support</Link></li>
              <li><Link to="/about" className="text-neutral-400 text-sm hover:text-white transition-colors">About Us</Link></li>
              <li><Link to="/contact" className="text-neutral-400 text-sm hover:text-white transition-colors">Contact Us</Link></li>
              <li><Link to="/privacy" className="text-neutral-400 text-sm hover:text-white transition-colors">Privacy Policy</Link></li>
              <li><Link to="/terms" className="text-neutral-400 text-sm hover:text-white transition-colors">Terms of Service</Link></li>
            </ul>
          </div>

          {/* Contact */}
          <div>
            <h4 className="font-semibold text-sm mb-4">Visit Us</h4>
            <div className="text-neutral-400 text-sm space-y-2">
              <p>Juja Town</p>
              <p>Jerry House, near Juja Posta</p>
              <p>Outside Shop No. 12</p>
              <p className="pt-2">+254 799 021 089</p>
              <p>herstepcollection@gmail.com</p>
            </div>
          </div>
        </div>

        <div className="border-t border-neutral-800 mt-10 pt-6 flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-neutral-500 text-sm">&copy; 2026 HerStep Collection. All rights reserved.</p>
          <div className="flex items-center gap-4">
            <a href="https://wa.me/254106624924" target="_blank" rel="noopener noreferrer" className="text-neutral-400 text-sm hover:text-white transition-colors">WhatsApp</a>
            <span className="text-neutral-700">|</span>
            <a href="tel:+254799021089" className="text-neutral-400 text-sm hover:text-white transition-colors">Call Us</a>
            <span className="text-neutral-700">|</span>
            <Link to="/admin" className="text-neutral-600 text-xs hover:text-neutral-400 transition-colors">Admin</Link>
          </div>
        </div>
      </div>
    </footer>
  );
}

function WhatsAppButton() {
  return (
    <a
      href="https://wa.me/254106624924"
      target="_blank"
      rel="noopener noreferrer"
      className="fixed bottom-6 right-6 z-50 w-14 h-14 bg-emerald-600 text-white rounded-full flex items-center justify-center shadow-lg hover:bg-emerald-700 transition-all hover:scale-105"
      aria-label="Chat on WhatsApp"
    >
      <svg viewBox="0 0 24 24" className="w-7 h-7 fill-current">
        <path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347m-5.421 7.403h-.004a9.87 9.87 0 01-5.031-1.378l-.361-.214-3.741.982.998-3.648-.235-.374a9.86 9.86 0 01-1.51-5.26c.001-5.45 4.436-9.884 9.888-9.884 2.64 0 5.122 1.03 6.988 2.898a9.825 9.825 0 012.893 6.994c-.003 5.45-4.437 9.884-9.885 9.884m8.413-18.297A11.815 11.815 0 0012.05 0C5.495 0 .16 5.335.157 11.892c0 2.096.547 4.142 1.588 5.945L.057 24l6.305-1.654a11.882 11.882 0 005.683 1.448h.005c6.554 0 11.89-5.335 11.893-11.893a11.821 11.821 0 00-3.48-8.413z"/>
      </svg>
    </a>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col">
      <Header />
      <main className="flex-1">{children}</main>
      <Footer />
      <WhatsAppButton />
    </div>
  );
}
