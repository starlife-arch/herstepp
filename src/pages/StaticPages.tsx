import React from 'react';
import { Card } from '../components/ui';

const Section = ({ title, children }: { title: string; children: React.ReactNode }) => (
  <section>
    <h2 className="text-lg font-semibold text-neutral-900 mb-2">{title}</h2>
    <div className="space-y-2">{children}</div>
  </section>
);

export function PrivacyPolicy() {
  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-12 animate-fadeIn">
      <h1 className="text-3xl font-bold text-neutral-900 mb-2">Privacy Policy</h1>
      <p className="text-sm text-neutral-500 mb-8">Last updated: 25 October 2026</p>
      <Card className="p-6 sm:p-8 prose prose-neutral max-w-none">
        <div className="space-y-6 text-sm text-neutral-600 leading-relaxed">
          <p>This policy explains how HerStep Collection (“HerStep”, “we”, “us”) handles personal information when you use our marketplace, create an account, buy products, sell products, contact support, or use related features. We aim to handle personal information in accordance with applicable Kenyan data-protection law.</p>
          <Section title="1. Information we collect">
            <p>Depending on how you use the platform, information may include your name, account details, email address, phone number, delivery or collection details, seller/business profile, product listings, orders, customer-support messages, and information you choose to provide.</p>
            <p>We also process transaction references, payment status and related records needed to confirm payments, manage orders, seller subscriptions, marketplace fees, refunds or disputes. We do not intend to collect or store your mobile-money PIN. Payment providers handle payment credentials through their own systems.</p>
            <p>Technical information such as device/browser details, log records, security events and usage of platform features may be collected to operate, protect and improve the service.</p>
          </Section>
          <Section title="2. How we use information">
            <p>We use information to create and secure accounts; display seller shops and listings; process orders and payments; coordinate fulfilment; provide receipts and order updates; administer seller plans, promotions and verification; prevent fraud and misuse; resolve support requests, returns and disputes; meet legal obligations; and maintain platform records.</p>
          </Section>
          <Section title="3. Marketplace sharing">
            <p>HerStep hosts listings from independent sellers. When an order is placed, relevant order and delivery information may be shared with the seller responsible for fulfilling it, and with delivery, payment, hosting, communications or other service providers where needed to operate the platform. Sellers should use buyer information only for the order and lawful related purposes.</p>
            <p>Information may also be disclosed where required by law, to protect users or the platform, or as part of a business transfer subject to appropriate safeguards. We do not sell personal information as a business model.</p>
          </Section>
          <Section title="4. Payments, fees and records">
            <p>Payment methods and payment service providers may vary by transaction. The platform may receive payment confirmations and transaction references without receiving your PIN. We retain relevant order and financial records for accounting, security, dispute handling and legal requirements.</p>
          </Section>
          <Section title="5. Cookies and technical services">
            <p>The platform and its service providers may use essential cookies, local storage or similar technologies to keep you signed in, remember preferences, protect accounts and make features work. Blocking these technologies may affect some features.</p>
          </Section>
          <Section title="6. Security and retention">
            <p>We use reasonable technical and organisational measures intended to protect information. No online service can guarantee absolute security. We keep information for as long as reasonably necessary for the purposes described here, including account operation, orders, legal obligations, dispute resolution and security, then delete or de-identify it where appropriate.</p>
          </Section>
          <Section title="7. Your choices and rights">
            <p>Subject to applicable law and verification of your identity, you may request access to or correction of your personal information, ask about its use, object to certain processing, or request deletion where we are not required or permitted to retain it. Some information must be kept to complete orders, maintain required records, prevent fraud or resolve disputes.</p>
          </Section>
          <Section title="8. Children">
            <p>The platform is intended for people able to enter into the relevant transactions under applicable law. If you believe a child has provided personal information inappropriately, contact us so we can review the matter.</p>
          </Section>
          <Section title="9. Changes to this policy">
            <p>We may update this policy as the platform or applicable law changes. The “Last updated” date above shows when this version was published. Continued use after an update is subject to applicable law and any consent required for the change.</p>
          </Section>
          <Section title="10. Contact and privacy requests">
            <p>Contact us at herstepcollection@gmail.com or +254 799 021 089. Our listed physical address is Jerry House, near Juja Posta, Juja Town, Kenya. Please do not send passwords, PINs or other secret credentials in a support request.</p>
          </Section>
        </div>
      </Card>
    </div>
  );
}

export function TermsOfService() {
  return (
    <div className="max-w-3xl mx-auto px-4 sm:px-6 py-12 animate-fadeIn">
      <h1 className="text-3xl font-bold text-neutral-900 mb-2">Terms &amp; Conditions</h1>
      <p className="text-sm text-neutral-500 mb-8">Last updated: 25 October 2026</p>
      <Card className="p-6 sm:p-8">
        <div className="space-y-6 text-sm text-neutral-600 leading-relaxed">
          <p>These terms govern use of the HerStep Collection website and marketplace (“platform”). By using the platform, you agree to these terms. If you do not agree, do not use the platform. “HerStep” refers to the platform operator; “seller” means a third-party merchant using the marketplace, and “buyer” means a customer purchasing through it.</p>
          <Section title="1. Marketplace role and seller responsibility">
            <p>The platform may display products offered by independent sellers. Unless a listing clearly states otherwise, the seller—not the platform— is responsible for product accuracy, quality, authenticity, stock, packaging, fulfilment, delivery arrangements and applicable product warranties. HerStep may review, approve, promote, suspend or remove listings, but listing review is not a guarantee of a product or seller.</p>
            <p>Seller business names, verification badges and promotional labels are platform features and should not be treated as a guarantee of performance or an endorsement of every product.</p>
          </Section>
          <Section title="2. Accounts and acceptable use">
            <p>Provide accurate account and contact information, keep your sign-in credentials secure, and promptly report suspected unauthorised access. Do not misuse the platform, submit misleading listings, infringe others’ rights, manipulate reviews or orders, evade fees, or use the service for unlawful activity. We may investigate suspected misuse and restrict, suspend or close accounts or listings where reasonably necessary, subject to applicable law.</p>
          </Section>
          <Section title="3. Listings, prices and orders">
            <p>Sellers are responsible for keeping listings, descriptions, prices, stock and business information accurate. Prices are shown in Kenya Shillings unless stated otherwise. Product availability and an order request do not guarantee acceptance. An order is considered paid only after the platform or relevant payment provider confirms payment. We may cancel or correct an order affected by a clear listing, stock, pricing or technical error and will communicate the next steps.</p>
          </Section>
          <Section title="4. Payments, fees and deductions">
            <p>Available payment methods and instructions are shown during checkout or in the relevant account flow. Follow only the payment instructions displayed by the platform and verify the transaction details before confirming. Never share your mobile-money PIN or password with a seller or support agent.</p>
            <p>Delivery charges, marketplace charges, seller subscription prices, promotion charges, verification charges, payout charges or other applicable fees will be shown in the relevant checkout, plan or feature information before you confirm the transaction, where applicable. Fees may differ by service and may change prospectively. A fee is not refundable unless the displayed terms, a confirmed platform decision or applicable law requires it.</p>
          </Section>
          <Section title="5. Delivery and collection">
            <p>Delivery options, estimated times, delivery charges and collection instructions depend on the seller, product and destination and should be confirmed in the listing or order details. Estimates are not guarantees. Buyers should provide accurate contact and delivery details; sellers should communicate material delays or fulfilment problems. Do not assume every seller offers collection from HerStep’s physical location.</p>
          </Section>
          <Section title="6. Cancellations, returns, refunds and disputes">
            <p>Check the listing and order details before paying. Return, exchange and cancellation eligibility can depend on the product, condition, seller policy, timing and applicable law. Contact support promptly with the order reference and a clear explanation if an item is missing, incorrect, damaged, not as described, or not delivered.</p>
            <p>HerStep may review evidence, contact the buyer and seller, and facilitate a resolution. A refund or exchange is not automatic merely because a request is submitted; the outcome depends on the facts, the applicable policy and the law. Where a refund is approved, the timing and method depend on the payment provider and transaction. Nothing in these terms removes any non-waivable consumer rights under applicable law.</p>
          </Section>
          <Section title="7. Seller accounts, plans and earnings">
            <p>Sellers must provide truthful business details, comply with listing and fulfilment rules, and maintain any required active seller status or plan to use plan-restricted features. Plan names, prices, product limits, expiry dates and included features are shown in the seller account or at purchase and may be updated for future periods.</p>
            <p>Only earnings marked available in the seller account may be eligible for withdrawal. Pending order amounts are not necessarily withdrawable. Withdrawals may be subject to verification, fees disclosed in the relevant flow, transaction limits, fraud checks, provider availability and applicable law. A displayed balance or payout status is not a guarantee that a transfer has completed until the platform confirms the final result.</p>
            <p>Sellers remain responsible for their own taxes, business licences and legal obligations unless applicable law provides otherwise. Do not create duplicate, misleading or unauthorised accounts to bypass limits or fees.</p>
          </Section>
          <Section title="8. Promotions and verification">
            <p>Promoted listings may receive additional placement and may be labelled as promoted or sponsored. Promotion does not guarantee sales, ranking for a fixed period unless expressly stated, or endorsement of the product. HerStep may decline, pause or remove promotions or verification features for policy, payment, safety or operational reasons, subject to any specific terms shown when the feature is purchased.</p>
          </Section>
          <Section title="9. Intellectual property and content">
            <p>You retain rights you hold in content you submit, but you grant the platform permission to host, display, format and distribute it as needed to operate the marketplace and advertise your listing on the platform. You must have the rights needed to upload product images, descriptions, logos and other content. We may remove content alleged to be unlawful or infringing.</p>
          </Section>
          <Section title="10. Platform availability and liability">
            <p>We work to keep the platform available and secure, but do not guarantee uninterrupted or error-free service. To the extent permitted by law, HerStep is not responsible for independent sellers’ acts, omissions or products, or indirect losses arising from platform use. Nothing in these terms excludes liability that cannot lawfully be excluded or limits statutory rights that cannot be waived.</p>
          </Section>
          <Section title="11. Changes, suspension and termination">
            <p>We may update platform features and these terms. Material changes will be reflected on this page with an updated date where appropriate. We may restrict access or remove content for security, legal, policy or operational reasons. Outstanding orders, approved refunds, payment obligations and other provisions that by their nature should continue will survive account closure as required.</p>
          </Section>
          <Section title="12. Governing law and contact">
            <p>These terms are governed by the laws of Kenya, subject to mandatory legal protections and the jurisdiction of competent courts. For questions or complaints, contact herstepcollection@gmail.com or +254 799 021 089. Our listed physical address is Jerry House, near Juja Posta, Juja Town, Kenya.</p>
          </Section>
          <p className="text-xs text-neutral-500">These terms and this privacy policy are platform information, not legal advice. The operator should have them reviewed by a qualified Kenyan legal professional before relying on them as final legal documents.</p>
        </div>
      </Card>
    </div>
  );
}
