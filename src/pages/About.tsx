import React from 'react';
import { Link } from 'react-router-dom';
import { MapPin, Phone, Mail, Clock, Facebook, Instagram, ShoppingBag, Store, PackageCheck, ShieldCheck, MessageCircle, Wallet, Sparkles } from 'lucide-react';
import { Card, Button } from '../components/ui';

const features = [
  { icon: ShoppingBag, title: 'Shop in one place', text: 'Explore products from HerStep Collection and participating independent sellers, with listings, prices and product details to help you compare options.' },
  { icon: Store, title: 'A marketplace for sellers', text: 'Eligible businesses can apply to open a seller account, create product listings, manage their shop profile and grow their reach through the platform.' },
  { icon: PackageCheck, title: 'Orders and tracking', text: 'Buyers can review order information and use order-tracking features where available. Sellers manage fulfilment and keep order progress updated.' },
  { icon: MessageCircle, title: 'Communication and support', text: 'Marketplace messaging and support options help buyers and sellers ask questions, resolve order concerns and get assistance.' },
  { icon: Wallet, title: 'Seller tools and earnings', text: 'Seller dashboards bring together available marketplace tools, plan information, order-related earnings and eligible payout requests. Availability depends on account status and the platform’s rules.' },
  { icon: ShieldCheck, title: 'Clear marketplace information', text: 'Seller profiles, verification badges and promoted listings help shoppers understand who is offering a product. A badge or promotion is not a guarantee of a product or seller’s performance.' },
];

export default function About() {
  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-12 animate-fadeIn">
      <div className="text-center mb-12">
        <p className="text-xs font-semibold tracking-[0.2em] text-neutral-500 uppercase mb-3">More than a shop</p>
        <h1 className="text-3xl sm:text-4xl font-bold text-neutral-900 mb-4">About HerStep Collection</h1>
        <p className="text-neutral-600 max-w-3xl mx-auto leading-relaxed">
          HerStep Collection is a Kenya-based shopping destination growing into an online marketplace. We bring together our own retail offering and participating independent sellers, helping customers discover products while giving sellers tools to present and manage their businesses online.
        </p>
      </div>

      <Card className="p-6 sm:p-8 mb-8">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 items-start">
          <div>
            <h2 className="text-xl font-semibold text-neutral-900 mb-3">Our story</h2>
            <p className="text-sm text-neutral-600 leading-relaxed">
              HerStep began with a simple idea: make stylish, affordable footwear easier to find for customers in Juja and beyond. As the business has grown, so has the vision. The website now supports a broader marketplace experience, where customers can explore listings and independent sellers can apply to bring their products to more shoppers.
            </p>
          </div>
          <div>
            <h2 className="text-xl font-semibold text-neutral-900 mb-3">Our mission</h2>
            <p className="text-sm text-neutral-600 leading-relaxed">
              We aim to make online shopping and selling more accessible, useful and straightforward—with clear product information, practical order tools and support when people need help. We continue to develop the platform as the needs of buyers and sellers evolve.
            </p>
          </div>
        </div>
      </Card>

      <div className="mb-12">
        <div className="text-center mb-6">
          <h2 className="text-2xl font-bold text-neutral-900">What you can do on HerStep</h2>
          <p className="text-sm text-neutral-500 mt-2">Tools and services for shoppers and marketplace sellers.</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {features.map(({ icon: Icon, title, text }) => (
            <Card key={title} className="p-5 h-full">
              <div className="w-10 h-10 rounded-xl bg-neutral-100 flex items-center justify-center mb-4">
                <Icon className="w-5 h-5 text-neutral-800" aria-hidden="true" />
              </div>
              <h3 className="font-semibold text-neutral-900 mb-2">{title}</h3>
              <p className="text-sm text-neutral-600 leading-relaxed">{text}</p>
            </Card>
          ))}
        </div>
      </div>

      <Card className="p-6 sm:p-8 mb-8">
        <div className="flex items-start gap-3 mb-4">
          <Sparkles className="w-6 h-6 text-neutral-700 mt-0.5" aria-hidden="true" />
          <div>
            <h2 className="text-xl font-semibold text-neutral-900 mb-2">A growing digital marketplace</h2>
            <p className="text-sm text-neutral-600 leading-relaxed">
              We are building a more connected shopping experience with seller storefronts, product discovery, order updates, customer communication and marketplace administration. Some tools or services may depend on eligibility, seller approval, location, product, payment confirmation or current platform availability.
            </p>
          </div>
        </div>
        <p className="text-sm text-neutral-600 leading-relaxed">
          HerStep may operate its own retail listings as well as host third-party sellers. For marketplace products, the seller shown on the listing is generally responsible for product details, stock and fulfilment unless the listing says otherwise. Please review the product page, seller information, delivery details and our <Link to="/terms" className="underline hover:text-neutral-900">Terms &amp; Conditions</Link> before placing an order.
        </p>
      </Card>

      <Card className="p-6 sm:p-8 bg-neutral-900 text-white border-0">
        <h2 className="text-xl font-bold mb-6">Visit or contact us</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
          <div className="space-y-4">
            <div className="flex items-start gap-3">
              <MapPin className="w-5 h-5 text-neutral-400 mt-0.5" />
              <div><p className="font-medium">Location</p><p className="text-sm text-neutral-400">Jerry House, near Juja Posta<br />Outside Shop No. 12<br />Juja Town, Kenya</p></div>
            </div>
            <div className="flex items-start gap-3">
              <Phone className="w-5 h-5 text-neutral-400 mt-0.5" />
              <div><p className="font-medium">Phone</p><a href="tel:+254799021089" className="text-sm text-neutral-400 hover:text-white">+254 799 021 089</a></div>
            </div>
          </div>
          <div className="space-y-4">
            <div className="flex items-start gap-3">
              <Mail className="w-5 h-5 text-neutral-400 mt-0.5" />
              <div><p className="font-medium">Email contacts</p>
                <div className="space-y-2 text-sm text-neutral-400">
                  <p><a href="mailto:support@herstepcollection.shop" className="hover:text-white underline">support@herstepcollection.shop</a><br /><span className="text-xs">Customer help and complaints</span></p>
                  <p><a href="mailto:marketplace@herstepcollection.shop" className="hover:text-white underline">marketplace@herstepcollection.shop</a><br /><span className="text-xs">Seller applications and marketplace matters</span></p>
                  <p><a href="mailto:orders@herstepcollection.shop" className="hover:text-white underline">orders@herstepcollection.shop</a><br /><span className="text-xs">Order and delivery enquiries</span></p>
                  <p><a href="mailto:partnerships@herstepcollection.shop" className="hover:text-white underline">partnerships@herstepcollection.shop</a><br /><span className="text-xs">Business partnerships and collaborations</span></p>
                </div>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <Clock className="w-5 h-5 text-neutral-400 mt-0.5" />
              <div><p className="font-medium">Store hours</p><p className="text-sm text-neutral-400">Mon - Sat: 8:00 AM - 7:00 PM<br />Sunday: 10:00 AM - 5:00 PM</p><p className="text-xs text-neutral-500 mt-1">Online marketplace features may be available outside store hours.</p></div>
            </div>
          </div>
        </div>
      </Card>

      <Card className="p-6 mt-8">
        <h2 className="text-lg font-semibold text-neutral-900 mb-2">Connect with HerStep Collection</h2>
        <p className="text-sm text-neutral-600 mb-4">Follow our social pages for new arrivals, marketplace updates and announcements.</p>
        <div className="flex flex-wrap gap-3">
          <a href="https://www.facebook.com/herstepcollections" target="_blank" rel="noopener noreferrer" aria-label="HerStep Collection on Facebook" className="inline-flex items-center gap-2 rounded-lg border border-neutral-200 px-4 py-3 text-sm font-medium text-neutral-800 hover:bg-neutral-50"><Facebook className="w-5 h-5" aria-hidden="true" /> Facebook</a>
          <a href="https://www.instagram.com/herstepcollections" target="_blank" rel="noopener noreferrer" aria-label="HerStep Collection on Instagram" className="inline-flex items-center gap-2 rounded-lg border border-neutral-200 px-4 py-3 text-sm font-medium text-neutral-800 hover:bg-neutral-50"><Instagram className="w-5 h-5" aria-hidden="true" /> Instagram</a>
          <a href="https://wa.me/254106624924" target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-2 rounded-lg border border-neutral-200 px-4 py-3 text-sm font-medium text-neutral-800 hover:bg-neutral-50"><MessageCircle className="w-5 h-5" aria-hidden="true" /> WhatsApp</a>
        </div>
      </Card>

      <div className="mt-8 flex flex-wrap justify-center gap-3">
        <Link to="/shop"><Button size="lg">Explore the Shop</Button></Link>
        <Link to="/seller/apply"><Button size="lg" variant="outline">Become a Seller</Button></Link>
        <Link to="/support"><Button size="lg" variant="outline">Get Support</Button></Link>
      </div>
    </div>
  );
}
