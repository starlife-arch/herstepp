# Marketplace notification event inventory

This is the current event map for adding marketplace email and Telegram notifications later. Notification delivery is intentionally not enabled by this document.

## Events already recorded

| Event | Current durable source | Intended future recipients |
|---|---|---|
| Seller applies | `sellerMarketplaceAudit` — `SELLER_APPLICATION_SUBMITTED` | Admin (Telegram/email), seller (confirmation email) |
| Admin approves/rejects/suspends seller | `sellerMarketplaceAudit` — admin application decision | Seller |
| Seller submits a product for review | `sellerMarketplaceAudit` — `SELLER_PRODUCT_SUBMITTED_FOR_REVIEW` | Admin (Telegram/email), seller (confirmation) |
| Admin approves/rejects/publishes a listing | `sellerMarketplaceAudit` — seller product moderation actions | Seller |
| Buyer reports a listing | `sellerMarketplaceAudit` — marketplace report actions | Admin (Telegram/email), seller only where appropriate after moderation |
| Buyer/seller sends a marketplace message | `sellerMarketplaceAudit` — `MARKETPLACE_MESSAGE_SENT` | Message recipient |
| Seller starts a subscription payment | `sellerMarketplaceAudit` — `SELLER_SUBSCRIPTION_PAYMENT_INITIATED` and `sellerSubscriptionPayments` | Seller, admin |
| Seller subscription payment is confirmed | `sellerMarketplaceAudit` — `SUBSCRIPTION_PAYMENT_CONFIRMED` and payment record | Seller, admin |
| Buyer pays for a marketplace order | Verified order/payment records and `sellerLedger` entries | Buyer, affected seller(s), admin |
| Refund requested/approved/rejected/confirmed | `refundRecords` and `auditLogs` | Buyer, affected seller(s), admin |
| Seller payout requested/reviewed/paid | `sellerPayouts`, `sellerLedger`, and `auditLogs` | Seller, admin |

## Delivery design requirements

- Treat payment provider confirmations, not a browser redirect or button click, as the source of truth for paid notifications.
- Keep event recording separate from delivery. A failed email or Telegram send must not roll back an order, refund, listing decision, or payment.
- Use an idempotent notification/outbox record keyed by event type and source record ID so provider retries do not send duplicates.
- Record delivery attempts, provider message IDs, timestamps, and retryable/permanent failures without logging full phone numbers, payment credentials, or unnecessary personal data.
- Resolve recipients from the authoritative user/seller/order/refund record at send time; do not trust recipient addresses supplied by the browser.
- Respect customer marketing consent for promotional messages. Transactional order/refund/account notices should be handled separately from marketing campaigns.
- Keep seller-specific order messages scoped to the seller's own order lines and never expose another seller's customer/order details.
- Do not send payout-confirmation messages until an external transfer is confirmed and recorded with its provider reference.

## Important limitation

The records above are currently split across marketplace audit events, payment/order/refund records, seller ledger entries, and general audit logs. Before turning on email/Telegram delivery, add a transactional notification outbox or equivalent idempotent dispatcher and test retries, partial failures, refund reversals, and mixed HerStep/seller baskets.
