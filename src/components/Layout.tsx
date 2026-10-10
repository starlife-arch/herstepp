import React, { useEffect, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { ShoppingBag, Menu, X, User, Search, Heart, ChevronDown, Facebook, Instagram, Phone, Mail, MessageCircle, Users, MessageSquare, Ticket, Headphones, ArrowUpRight } from 'lucide-react';
import { useApp } from '../context/AppContext';
import { loadAnnouncement, type AnnouncementData } from '../lib/storefront';
import { HerStepAIChat } from './HerStepAIChat';

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
            <div className="w-10 h-10 flex items-center justify-center overflow-hidden rounded-lg bg-white">
              <img src="/favicon.svg" alt="HerStep Collection" className="w-full h-full object-contain" />
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
            <Link
              to="/tip"
              aria-label="Treat the team"
              title="Treat the team"
              className="p-2 rounded-lg hover:bg-neutral-100 transition-colors"
            >
              <Heart className="w-5 h-5 text-neutral-600" />
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
            <Link to="/tip" onClick={() => setMobileOpen(false)} className="flex items-center gap-2 px-3 py-2.5 rounded-lg text-sm font-medium text-neutral-600 hover:bg-neutral-50">
              <Heart className="w-4 h-4" />
              Treat the team
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
              <div className="w-10 h-10 flex items-center justify-center overflow-hidden rounded-lg bg-white">
                <img src="/favicon.svg" alt="HerStep Collection" className="w-full h-full object-contain" />
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
              <li><Link to="/tip" className="text-neutral-400 text-sm hover:text-white transition-colors">Treat the team</Link></li>
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
              <p className="pt-2"><a href="tel:+254799021089" className="hover:text-white">+254 799 021 089</a></p>
              <p><a href="mailto:herstepcollection@gmail.com" className="hover:text-white">herstepcollection@gmail.com</a></p>
            </div>
          </div>
        </div>

        <div className="border-t border-neutral-800 mt-10 pt-6 flex flex-col sm:flex-row items-center justify-between gap-4">
          <p className="text-neutral-500 text-sm">&copy; 2026 HerStep Collection. All rights reserved.</p>
          <div className="flex items-center gap-4">
            <a href="https://www.facebook.com/herstepcollections" target="_blank" rel="noopener noreferrer" aria-label="HerStep Collection on Facebook" className="text-neutral-400 hover:text-white transition-colors"><Facebook className="w-5 h-5" aria-hidden="true" /></a>
            <a href="https://www.instagram.com/herstepcollections" target="_blank" rel="noopener noreferrer" aria-label="HerStep Collection on Instagram" className="text-neutral-400 hover:text-white transition-colors"><Instagram className="w-5 h-5" aria-hidden="true" /></a>
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
  const [open, setOpen] = useState(false);
  const close = () => setOpen(false);

  const whatsappGroup = 'https://chat.whatsapp.com/Is8vNzODABCBiOPM88VmmA?s=cl&p=a&mlu=4';

  return (
    <div className="fixed bottom-5 right-4 sm:bottom-6 sm:right-6 z-50 flex flex-col items-end gap-3">
      {open && (
        <div
          id="herstep-support-menu"
          role="dialog"
          aria-label="HerStep Collection support options"
          className="w-[min( calc(100vw - 2rem), 21rem)] sm:w-80 max-h-[min(75vh,36rem)] overflow-y-auto rounded-2xl border border-neutral-200 bg-white text-neutral-900 shadow-2xl animate-fadeIn"
        >
          <div className="flex items-center justify-between border-b border-neutral-100 px-4 py-3">
            <div>
              <p className="font-semibold text-sm">How can we help?</p>
              <p className="text-xs text-neutral-500 mt-0.5">Choose how to contact HerStep Collection</p>
            </div>
            <button type="button" onClick={close} aria-label="Close support menu" className="rounded-full p-2 text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900">
              <X className="w-5 h-5" aria-hidden="true" />
            </button>
          </div>
          <nav className="p-2" aria-label="Contact options">
            <a href="tel:+254799021089" onClick={close} className="flex items-center gap-3 rounded-xl px-3 py-3 hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400">
              <Phone className="w-5 h-5 shrink-0 text-neutral-700" aria-hidden="true" />
              <span className="flex-1"><span className="block text-sm font-medium">Call us</span><span className="block text-xs text-neutral-500">+254 799 021 089</span></span>
              <ArrowUpRight className="w-4 h-4 text-neutral-400" aria-hidden="true" />
            </a>
            <a href="https://wa.me/254106624924" target="_blank" rel="noopener noreferrer" onClick={close} className="flex items-center gap-3 rounded-xl px-3 py-3 hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400">
              <svg viewBox="0 0 24 24" className="w-5 h-5 shrink-0 fill-current text-neutral-700" aria-hidden="true"><path d="M20.52 3.48A11.8 11.8 0 0 0 12.1 0C5.55 0 .22 5.33.22 11.88c0 2.1.55 4.15 1.6 5.96L.12 24l6.31-1.66a11.9 11.9 0 0 0 5.66 1.44h.01c6.55 0 11.88-5.33 11.88-11.88a11.8 11.8 0 0 0-3.46-8.42ZM12.1 21.76h-.01a9.9 9.9 0 0 1-5.04-1.38l-.36-.21-3.75.98 1-3.65-.24-.38a9.84 9.84 0 0 1-1.51-5.24c0-5.47 4.45-9.92 9.91-9.92a9.86 9.86 0 0 1 7.02 2.91 9.85 9.85 0 0 1 2.9 7.01c0 5.47-4.45 9.92-9.92 9.92Zm5.44-7.43c-.3-.15-1.77-.87-2.04-.97-.27-.1-.47-.15-.67.15-.2.3-.77.97-.94 1.17-.17.2-.35.22-.65.07-.3-.15-1.26-.46-2.4-1.47-.89-.79-1.49-1.77-1.66-2.07-.17-.3-.02-.46.13-.61.13-.13.3-.35.45-.52.15-.18.2-.3.3-.5.1-.2.05-.37-.03-.52-.07-.15-.67-1.62-.92-2.22-.24-.58-.49-.5-.67-.51h-.57c-.2 0-.52.07-.79.37-.27.3-1.04 1.02-1.04 2.48s1.07 2.87 1.22 3.07c.15.2 2.1 3.2 5.08 4.49.71.3 1.27.49 1.7.62.71.23 1.36.2 1.87.12.57-.08 1.77-.72 2.02-1.41.25-.7.25-1.29.17-1.42-.07-.12-.27-.2-.57-.35Z"/></svg>
              <span className="flex-1"><span className="block text-sm font-medium">WhatsApp</span><span className="block text-xs text-neutral-500">Chat with our team</span></span>
              <ArrowUpRight className="w-4 h-4 text-neutral-400" aria-hidden="true" />
            </a>
            <a href="mailto:herstepcollection@gmail.com" onClick={close} className="flex items-center gap-3 rounded-xl px-3 py-3 hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400">
              <Mail className="w-5 h-5 shrink-0 text-neutral-700" aria-hidden="true" />
              <span className="flex-1"><span className="block text-sm font-medium">Email us</span><span className="block text-xs text-neutral-500">herstepcollection@gmail.com</span></span>
              <ArrowUpRight className="w-4 h-4 text-neutral-400" aria-hidden="true" />
            </a>
            <a href="https://www.facebook.com/herstepcollections" target="_blank" rel="noopener noreferrer" onClick={close} className="flex items-center gap-3 rounded-xl px-3 py-3 hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400">
              <Facebook className="w-5 h-5 shrink-0 text-neutral-700" aria-hidden="true" />
              <span className="flex-1 text-sm font-medium">Facebook</span><ArrowUpRight className="w-4 h-4 text-neutral-400" aria-hidden="true" />
            </a>
            <a href="https://www.instagram.com/herstepcollections" target="_blank" rel="noopener noreferrer" onClick={close} className="flex items-center gap-3 rounded-xl px-3 py-3 hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400">
              <Instagram className="w-5 h-5 shrink-0 text-neutral-700" aria-hidden="true" />
              <span className="flex-1 text-sm font-medium">Instagram</span><ArrowUpRight className="w-4 h-4 text-neutral-400" aria-hidden="true" />
            </a>
            <a href={whatsappGroup} target="_blank" rel="noopener noreferrer" onClick={close} className="flex items-center gap-3 rounded-xl px-3 py-3 hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400">
              <Users className="w-5 h-5 shrink-0 text-neutral-700" aria-hidden="true" />
              <span className="flex-1 text-sm font-medium">Join our WhatsApp group</span><ArrowUpRight className="w-4 h-4 text-neutral-400" aria-hidden="true" />
            </a>
            <Link to="/contact" onClick={close} className="flex items-center gap-3 rounded-xl px-3 py-3 hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400">
              <MessageSquare className="w-5 h-5 shrink-0 text-neutral-700" aria-hidden="true" />
              <span className="flex-1 text-sm font-medium">Send us a message</span><ChevronDown className="w-4 h-4 -rotate-90 text-neutral-400" aria-hidden="true" />
            </Link>
            <Link to="/support" onClick={close} className="flex items-center gap-3 rounded-xl px-3 py-3 hover:bg-neutral-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-400">
              <Ticket className="w-5 h-5 shrink-0 text-neutral-700" aria-hidden="true" />
              <span className="flex-1 text-sm font-medium">Open a support ticket</span><ChevronDown className="w-4 h-4 -rotate-90 text-neutral-400" aria-hidden="true" />
            </Link>
          </nav>
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen(value => !value)}
        aria-label={open ? 'Close support options' : 'Open support options'}
        aria-expanded={open}
        aria-controls="herstep-support-menu"
        className="w-14 h-14 rounded-full bg-neutral-900 text-white flex items-center justify-center shadow-lg hover:bg-neutral-800 transition-all hover:scale-105 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-500 focus-visible:ring-offset-2"
      >
        {open ? <X className="w-6 h-6" aria-hidden="true" /> : <Headphones className="w-7 h-7" aria-hidden="true" />}
      </button>
    </div>
  );
}

// Announcement bar (settings/announcement via GET /api/announcement). Rendered
// ABOVE the sticky header so it never shifts the header or changes its spacing
// when hidden (it simply is not in the tree). Dismissible for the session: the
// dismissal is keyed by a hash of the message, so an edited message shows
// again. No links other than the admin-configured https one; role=status for
// screen readers.
async function sha256Short(text: string): Promise<string> {
  try {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return Array.from(new Uint8Array(digest)).slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
  } catch {
    // Non-secure contexts have no SubtleCrypto — a simple string hash is fine
    // here (it only keys a sessionStorage entry).
    let h = 0;
    for (let i = 0; i < text.length; i += 1) h = (h * 31 + text.charCodeAt(i)) | 0;
    return `f${(h >>> 0).toString(16)}`;
  }
}

export function AnnouncementBar() {
  const [announcement, setAnnouncement] = useState<AnnouncementData | null>(null);
  const [dismissed, setDismissed] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void loadAnnouncement().then(async data => {
      if (cancelled || !data?.enabled || !data.message) return;
      const key = `herstep-announcement-${await sha256Short(data.message)}`;
      if (sessionStorage.getItem(key)) return;
      setAnnouncement({ ...data, __key: key } as AnnouncementData & { __key: string });
      setDismissed(false);
    });
    return () => { cancelled = true; };
  }, []);

  if (!announcement || dismissed) return null;
  const dismiss = () => {
    try { sessionStorage.setItem((announcement as any).__key, '1'); } catch { /* private mode */ }
    setDismissed(true);
  };
  return (
    <div role="status" className="bg-neutral-900 text-white text-sm">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-2 flex items-center justify-center gap-3 flex-wrap">
        <p className="text-center sm:text-left">{announcement.message}</p>
        {announcement.linkUrl && announcement.linkLabel && (
          <a href={announcement.linkUrl} target="_blank" rel="noopener noreferrer" className="underline underline-offset-2 font-medium hover:text-neutral-200">
            {announcement.linkLabel}
          </a>
        )}
        <button type="button" onClick={dismiss} aria-label="Dismiss announcement" className="absolute right-4 sm:static ml-2 h-6 w-6 rounded-full flex items-center justify-center hover:bg-white/10 text-neutral-300">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col">
      <AnnouncementBar />
      <Header />
      <main className="flex-1">{children}</main>
      <Footer />
      <HerStepAIChat />
      <WhatsAppButton />
    </div>
  );
}
