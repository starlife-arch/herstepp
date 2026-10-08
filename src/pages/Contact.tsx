import React, { useEffect, useState } from 'react';
import { MapPin, Phone, Mail, Clock, Send, MessageSquare } from 'lucide-react';
import { Link } from 'react-router-dom';
import { Card, Button, Input } from '../components/ui';
import { useApp } from '../context/AppContext';
import { apiFetch } from '../lib/api';
import { usePageMeta } from '../hooks/usePageMeta';


export default function Contact() {
  usePageMeta('Contact Us | HerStep Collection', "Talk to HerStep Collection in Juja Town — call, WhatsApp or send us a message and we usually reply within one working day.");
  const { state } = useApp();
  const [form, setForm] = useState({ name: '', email: '', phone: '', message: '' });
  // Honeypot: bots fill it, humans never see it (visually hidden input below).
  const [website, setWebsite] = useState('');
  const [sent, setSent] = useState(false);
  const [messageId, setMessageId] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Prefill for signed-in users (smallest edit: one effect, no markup change).
  useEffect(() => {
    if (state.user) {
      setForm(prev => ({
        ...prev,
        name: prev.name || state.user?.name || '',
        email: prev.email || state.user?.email || '',
        phone: prev.phone || state.user?.phone || '',
      }));
    }
  }, [state.user]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const result: any = await apiFetch('/api/contact', {
        method: 'POST',
        body: JSON.stringify({
          name: form.name,
          email: form.email,
          phone: form.phone || undefined,
          message: form.message,
          website,
        }),
      });
      setMessageId(typeof result?.messageId === 'string' ? result.messageId : '');
      setSent(true);
    } catch (err: any) {
      // Server validation / rate-limit messages shown inline in the red box.
      setError(err?.message || 'We could not send your message. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="max-w-5xl mx-auto px-4 sm:px-6 py-12 animate-fadeIn">
      <div className="text-center mb-12">
        <h1 className="text-3xl font-bold text-neutral-900 mb-3">Contact Us</h1>
        <p className="text-neutral-500 max-w-xl mx-auto">
          Have a question? We'd love to hear from you. Reach out through any of the channels below.
        </p>
        {state.user && (
          <p className="text-sm text-neutral-500 mt-2">
            Have an order?{' '}
            <Link to="/support" className="text-neutral-900 underline">Open a support ticket</Link>
            {' '}for faster help.
          </p>
        )}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6 mb-12">
        <Card className="p-6 text-center">
          <div className="w-12 h-12 bg-neutral-100 rounded-xl flex items-center justify-center mx-auto mb-3">
            <Phone className="w-5 h-5 text-neutral-700" />
          </div>
          <h3 className="font-semibold text-neutral-900 text-sm mb-1">Call Us</h3>
          <a href="tel:+254799021089" className="text-sm text-neutral-600 hover:text-neutral-900">+254 799 021 089</a>
        </Card>
        <Card className="p-6 text-center">
          <div className="w-12 h-12 bg-neutral-100 rounded-xl flex items-center justify-center mx-auto mb-3">
            <MessageSquare className="w-5 h-5 text-neutral-700" />
          </div>
          <h3 className="font-semibold text-neutral-900 text-sm mb-1">WhatsApp</h3>
          <a href="https://wa.me/254106624924" target="_blank" rel="noopener noreferrer" className="text-sm text-neutral-600 hover:text-neutral-900">+254 106 624 924</a>
        </Card>
        <Card className="p-6 text-center">
          <div className="w-12 h-12 bg-neutral-100 rounded-xl flex items-center justify-center mx-auto mb-3">
            <Mail className="w-5 h-5 text-neutral-700" />
          </div>
          <h3 className="font-semibold text-neutral-900 text-sm mb-1">Email</h3>
          <a href="mailto:herstepcollection@gmail.com" className="text-sm text-neutral-600 hover:text-neutral-900">herstepcollection@gmail.com</a>
        </Card>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Contact Form */}
        <Card className="p-6">
          <h2 className="text-lg font-semibold text-neutral-900 mb-4">Send a Message</h2>
          {sent ? (
            <div className="text-center py-8">
              <div className="w-12 h-12 bg-emerald-50 rounded-xl flex items-center justify-center mx-auto mb-3">
                <Send className="w-5 h-5 text-emerald-600" />
              </div>
              <p className="font-medium text-neutral-900">Message Sent</p>
              <p className="text-sm text-neutral-500 mt-1">We'll get back to you shortly.</p>
              {messageId && (
                <p className="text-xs text-neutral-400 mt-2 font-mono">Reference: {messageId}</p>
              )}
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-4">
              <Input label="Name" value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} placeholder="Your name" required />
              <Input label="Email" type="email" value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} placeholder="your@email.com" required />
              <Input label="Phone" value={form.phone} onChange={e => setForm({ ...form, phone: e.target.value })} placeholder="+254 7XX XXX XXX" />
              <div>
                <label className="block text-sm font-medium text-neutral-700 mb-1.5">Message</label>
                <textarea
                  value={form.message}
                  onChange={e => setForm({ ...form, message: e.target.value })}
                  className="w-full px-3.5 py-2.5 border border-neutral-300 rounded-lg text-sm h-28 resize-none"
                  placeholder="How can we help?"
                  required
                />
              </div>
              {/* Honeypot anti-spam field: visually hidden, never tabbed into. */}
              <input
                type="text"
                name="website"
                value={website}
                onChange={e => setWebsite(e.target.value)}
                tabIndex={-1}
                autoComplete="off"
                aria-hidden="true"
                className="absolute left-[-9999px] top-[-9999px] h-0 w-0 opacity-0"
              />
              {error && (
                <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
                  {error}
                </div>
              )}
              <Button type="submit" size="lg" className="w-full" loading={submitting}>Send Message</Button>
            </form>
          )}
        </Card>

        {/* Location */}
        <Card className="p-6">
          <h2 className="text-lg font-semibold text-neutral-900 mb-4">Visit Our Store</h2>
          <div className="space-y-4">
            <div className="flex items-start gap-3">
              <MapPin className="w-5 h-5 text-neutral-500 mt-0.5" />
              <div>
                <p className="font-medium text-sm text-neutral-900">Address</p>
                <p className="text-sm text-neutral-600">Jerry House, near Juja Posta<br />Outside Shop No. 12<br />Juja Town, Kenya</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <Clock className="w-5 h-5 text-neutral-500 mt-0.5" />
              <div>
                <p className="font-medium text-sm text-neutral-900">Business Hours</p>
                <p className="text-sm text-neutral-600">Monday - Saturday: 8:00 AM - 7:00 PM</p>
                <p className="text-sm text-neutral-600">Sunday: 10:00 AM - 5:00 PM</p>
              </div>
            </div>
            <div className="flex items-start gap-3">
              <Phone className="w-5 h-5 text-neutral-500 mt-0.5" />
              <div>
                <p className="font-medium text-sm text-neutral-900">Phone</p>
                <p className="text-sm text-neutral-600">+254 799 021 089</p>
              </div>
            </div>
            <div className="mt-6 p-4 bg-neutral-50 rounded-lg">
              <p className="text-sm font-medium text-neutral-900 mb-1">Need immediate help?</p>
              <p className="text-xs text-neutral-500 mb-3">For order tracking, payment issues, or support tickets, visit our support center.</p>
              <Link to="/support"><Button variant="outline" size="sm">Go to Support</Button></Link>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
