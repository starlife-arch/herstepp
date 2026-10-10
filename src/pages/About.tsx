import React from 'react';
import { Link } from 'react-router-dom';
import { MapPin, Phone, Mail, Clock, Facebook, Instagram } from 'lucide-react';
import { Card, Button } from '../components/ui';

export default function About() {
  return (
    <div className="max-w-4xl mx-auto px-4 sm:px-6 py-12 animate-fadeIn">
      <div className="text-center mb-12">
        <h1 className="text-3xl font-bold text-neutral-900 mb-3">About HerStep Collection</h1>
        <p className="text-neutral-500 max-w-2xl mx-auto leading-relaxed">
          We are a premium ladies' footwear store based in Juja Town, Kenya. Our mission is to help women step into their style with quality, affordable shoes for every occasion.
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-12">
        <Card className="p-6">
          <h2 className="text-lg font-semibold text-neutral-900 mb-3">Our Story</h2>
          <p className="text-sm text-neutral-600 leading-relaxed">
            HerStep Collection started with a simple vision: to provide ladies in Juja and beyond with access to stylish, quality footwear at fair prices. From thrifted summer sandals to elegant heels, we curate every pair with care.
          </p>
        </Card>
        <Card className="p-6">
          <h2 className="text-lg font-semibold text-neutral-900 mb-3">What We Offer</h2>
          <ul className="text-sm text-neutral-600 space-y-2">
            <li>Thrifted & Fancy Summer Sandals</li>
            <li>Platform Shoes</li>
            <li>Laser-Up Shoes</li>
            <li>Block Heels & Stiletto Heels</li>
            <li>Kitten Heels & Flats</li>
            <li>Mary Jane Low-Cuts</li>
          </ul>
        </Card>
      </div>

      <Card className="p-8 bg-neutral-900 text-white border-0">
        <h2 className="text-xl font-bold mb-6">Visit Our Store</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-6">
          <div className="space-y-4">
            <div className="flex items-start gap-3">
              <MapPin className="w-5 h-5 text-neutral-400 mt-0.5" />
              <div>
                <p className="font-medium">Location</p>
                <p className="text-sm text-neutral-400">Jerry House, near Juja Posta<br />Outside Shop No. 12<br />Juja Town</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <Phone className="w-5 h-5 text-neutral-400 mt-0.5" />
              <div>
                <p className="font-medium">Phone</p>
                <a href="tel:+254799021089" className="text-sm text-neutral-400 hover:text-white">+254 799 021 089</a>
              </div>
            </div>
          </div>
          <div className="space-y-4">
            <div className="flex items-start gap-3">
              <Mail className="w-5 h-5 text-neutral-400 mt-0.5" />
              <div>
                <p className="font-medium">Email</p>
                <a href="mailto:herstepcollection@gmail.com" className="text-sm text-neutral-400 hover:text-white">herstepcollection@gmail.com</a>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <Clock className="w-5 h-5 text-neutral-400 mt-0.5" />
              <div>
                <p className="font-medium">Hours</p>
                <p className="text-sm text-neutral-400">Mon - Sat: 8:00 AM - 7:00 PM<br />Sunday: 10:00 AM - 5:00 PM</p>
              </div>
            </div>
          </div>
        </div>
      </Card>

      <Card className="p-6 mt-8">
        <h2 className="text-lg font-semibold text-neutral-900 mb-2">Connect With HerStep Collection</h2>
        <p className="text-sm text-neutral-600 mb-4">Follow our official social media pages for new arrivals, styles, and updates.</p>
        <div className="flex flex-wrap gap-4">
          <a href="https://www.facebook.com/herstepcollections" target="_blank" rel="noopener noreferrer" aria-label="HerStep Collection on Facebook" className="inline-flex items-center gap-2 rounded-lg border border-neutral-200 px-4 py-3 text-sm font-medium text-neutral-800 hover:bg-neutral-50">
            <Facebook className="w-5 h-5" aria-hidden="true" /> Facebook
          </a>
          <a href="https://www.instagram.com/herstepcollections" target="_blank" rel="noopener noreferrer" aria-label="HerStep Collection on Instagram" className="inline-flex items-center gap-2 rounded-lg border border-neutral-200 px-4 py-3 text-sm font-medium text-neutral-800 hover:bg-neutral-50">
            <Instagram className="w-5 h-5" aria-hidden="true" /> Instagram
          </a>
        </div>
        <p className="text-sm text-neutral-600 mt-5">Phone: <a className="underline" href="tel:+254799021089">+254 799 021 089</a> · WhatsApp: <a className="underline" href="https://wa.me/254106624924" target="_blank" rel="noopener noreferrer">+254 106 624 924</a></p>
      </Card>

      <div className="mt-8 text-center">
        <Link to="/shop"><Button size="lg">Shop Now</Button></Link>
      </div>
    </div>
  );
}
