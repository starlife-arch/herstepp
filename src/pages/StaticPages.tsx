import React from 'react';
import { Card } from '../components/ui';

export function PrivacyPolicy() {
  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-12 animate-fadeIn">
      <h1 className="text-3xl font-bold text-neutral-900 mb-2">Privacy Policy</h1>
      <p className="text-sm text-neutral-500 mb-8">Last updated: March 2026</p>
      <Card className="p-6 sm:p-8 prose prose-neutral max-w-none">
        <div className="space-y-6 text-sm text-neutral-600 leading-relaxed">
          <section>
            <h2 className="text-lg font-semibold text-neutral-900 mb-2">1. Information We Collect</h2>
            <p>We collect information you provide directly, including your name, email address, phone number, and delivery address when you create an account or place an order. We also collect payment information processed securely through M-Pesa.</p>
          </section>
          <section>
            <h2 className="text-lg font-semibold text-neutral-900 mb-2">2. How We Use Your Information</h2>
            <p>We use your information to process orders, communicate about your orders and account, provide customer support, and improve our services. We never sell your personal information to third parties.</p>
          </section>
          <section>
            <h2 className="text-lg font-semibold text-neutral-900 mb-2">3. Data Security</h2>
            <p>We implement appropriate security measures to protect your personal information. Payment transactions are processed securely through M-Pesa and we never store sensitive payment credentials.</p>
          </section>
          <section>
            <h2 className="text-lg font-semibold text-neutral-900 mb-2">4. Your Rights</h2>
            <p>You have the right to access, correct, or delete your personal information. Contact us at herstepcollection@gmail.com for any privacy-related requests.</p>
          </section>
          <section>
            <h2 className="text-lg font-semibold text-neutral-900 mb-2">5. Contact Us</h2>
            <p>For privacy concerns, contact us at:<br />Email: herstepcollection@gmail.com<br />Phone: +254 799 021 089<br />Address: Jerry House, near Juja Posta, Juja Town</p>
          </section>
        </div>
      </Card>
    </div>
  );
}

export function TermsOfService() {
  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-12 animate-fadeIn">
      <h1 className="text-3xl font-bold text-neutral-900 mb-2">Terms of Service</h1>
      <p className="text-sm text-neutral-500 mb-8">Last updated: March 2026</p>
      <Card className="p-6 sm:p-8">
        <div className="space-y-6 text-sm text-neutral-600 leading-relaxed">
          <section>
            <h2 className="text-lg font-semibold text-neutral-900 mb-2">1. Acceptance of Terms</h2>
            <p>By accessing and using the HerStep Collection platform, you agree to be bound by these terms of service. If you do not agree, please do not use our services.</p>
          </section>
          <section>
            <h2 className="text-lg font-semibold text-neutral-900 mb-2">2. Orders and Payments</h2>
            <p>All orders are subject to product availability and payment confirmation. Prices are displayed in Kenya Shillings (KSh). Payment is processed via M-Pesa STK Push. An order is only confirmed upon successful payment verification.</p>
          </section>
          <section>
            <h2 className="text-lg font-semibold text-neutral-900 mb-2">3. Delivery</h2>
            <p>Delivery times are estimates and not guaranteed. We offer both delivery and in-store collection at our Juja Town location. Delivery fees vary by location.</p>
          </section>
          <section>
            <h2 className="text-lg font-semibold text-neutral-900 mb-2">4. Returns and Exchanges</h2>
            <p>We accept returns and exchanges within 48 hours of delivery for unworn items in original condition. Contact our support team to initiate a return.</p>
          </section>
          <section>
            <h2 className="text-lg font-semibold text-neutral-900 mb-2">5. Scam Warning</h2>
            <p>Always verify you are communicating with official HerStep Collection channels. Our official contacts are: Phone +254 799 021 089, WhatsApp +254 106 624 924. Never send payment to unofficial numbers.</p>
          </section>
          <section>
            <h2 className="text-lg font-semibold text-neutral-900 mb-2">6. Contact</h2>
            <p>For questions about these terms, contact us at herstepcollection@gmail.com or visit our store at Jerry House, near Juja Posta, Juja Town.</p>
          </section>
        </div>
      </Card>
    </div>
  );
}
