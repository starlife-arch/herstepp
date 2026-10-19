# HerStep Collection Seller Marketplace — Rollout Plan

## Goals

Turn HerStep Collection into a multi-vendor marketplace without disrupting the existing first-party shop, checkout, orders, reviews, Aria, refunds, or admin tools. Marketplace work is additive and must be delivered behind explicit seller/product eligibility checks.

## Rollout sequence

### Phase 1 — Seller onboarding and governance
- Seller application with contact/business details, seller display name, product categories, and acceptance of seller terms.
- Admin review queue: approve, reject with reason, suspend, and reinstate.
- Approved seller profile with status, plan, verification badge state, created/updated timestamps, and audit history.
- Seller dashboard with application status, listing counts, subscription state, and clear next steps.
- Server-side authorization: a seller may read/update only their own profile and manage only products whose `sellerId` matches their seller record. Never trust seller IDs supplied by the browser.
- Existing HerStep-owned products remain first-party products. Existing admin product routes and admin role checks stay intact.

### Phase 2 — Seller listings and customer marketplace
- Add optional `sellerId` and `sellerSnapshot` fields to product documents. Existing products without a seller remain first-party.
- Seller product create/edit/archive routes validate all existing product rules, categories, price, inventory, images, and listing quotas.
- Public catalogue includes only ACTIVE products belonging to active/approved sellers; suspended sellers' listings are hidden. Expired plans follow the agreed grace-period policy.
- Product cards and details show the seller identity and verified badge only when granted by an admin. Product reviews remain product-specific and existing verified-purchase moderation remains in place.
- Buyer/seller messaging, product/message reporting, user blocking, and admin moderation are later safety-focused milestones, not implicit permissions to expose private contact data.

### Phase 3 — Plans, paid add-ons and entitlement enforcement
- Store server-calculated plan entitlements and billing status; never accept price or plan privileges from client requests.
- Plans discussed so far (monthly, KSh):
  - Starter: 150; optional verified badge add-on 50; total 200 with badge.
  - Standard (up to 100 products): 350; optional badge 50; total 400 with badge.
  - Growth (up to 1,000 products): 800; optional badge 50; total 850 with badge.
  - Unlimited + priority support: 1,500; optional badge 50; total 1,550 with badge.
- The above are prior proposed prices and must be confirmed before enabling paid subscriptions. Define product quotas, billing period, renewal, grace period, downgrade behavior, cancellation, and refunds in seller terms.
- Add-on A — **Promoted listing / appear higher**: KSh 100 per eligible product for 7 days. Mark placements as “Promoted”/“Sponsored”; never sell an undisclosed ranking. Ranking should rotate fairly and be capped so organic results remain useful. Record campaign start/end, payment reference, seller/product, status, and audit trail. Never guarantee a specific number of views or sales.
- Add-on B — **AI bulk upload credits**: KSh 100 per batch of 10 products. Sellers upload product photos/ZIP, review AI-extracted names/prices/categories/sizes before publishing, and consume the paid allowance only for accepted/processed items according to clear terms. Enforce seller ownership, file limits, quota/rate limits, and idempotent credit deductions server-side. Reuse the existing admin bulk-upload analysis only after separating seller-safe functionality from admin-only routes and credentials.
- These confirmed prices are recorded in the rollout plan; payment collection and entitlement granting remain disabled until payment verification, idempotency, and seller-facing purchase flows are implemented and tested.

### Phase 4 — Orders, fees, payouts and support
- Marketplace sales commission is 0% (no sales commission). Shipping responsibility, split-order behavior, cancellations/returns, dispute handling, and tax/receipt obligations must still be defined before accepting marketplace payments.
- Existing checkout currently serves the existing shop. Do not redirect or alter live payment flow until the marketplace payment and order ownership model is tested.
- Customer payments are to land in the HerStep account first. Maintain a ledger per seller: gross order, platform fee, refunds/chargebacks, adjustments, available balance, pending balance, and payout records.
- Do not label balances “paid” until payout is actually confirmed. Add admin-controlled payout approval, immutable audit logs, idempotency, reconciliation, and clear payout status.
- Verified paid marketplace order lines are written to `sellerLedger` as deterministic `ORDER_PAYMENT_PENDING` entries with a 0% platform fee. These entries are not withdrawable: a separate delivery/refund lifecycle must release or adjust them before payout management is enabled.
- Seller order views must show only their own order line items and only the customer information needed to fulfill them.
- Seller payout requests are server-validated against the available seller ledger, reserve funds while `REQUESTED`/`APPROVED`, and are idempotent. Admin must approve/reject and only record `PAID` after an external transfer is confirmed with its provider reference; no transfer is initiated by this workflow.
- Seller earnings linked to orders with refund status `REQUESTED`, `APPROVED`, `CONFIRMED`, or `PARTIALLY_REFUNDED` are held from payout availability until refund/ledger reconciliation is completed. This conservative hold prevents payout of disputed amounts.

## Suggested data collections

- `sellerApplications/{applicationId}`: applicant UID, contact/business details, requested display name/categories, status (`PENDING`, `APPROVED`, `REJECTED`), admin reason, timestamps.
- `sellers/{sellerId}`: owner UID, display name, status (`ACTIVE`, `SUSPENDED`, `CLOSED`), plan/billing state, listing limits, badge entitlement, timestamps.
- `sellerSubscriptions/{subscriptionId}`: seller ID, plan code, amount/currency, period start/end, payment reference, status, idempotency key.
- `sellerAddons/{addonId}`: seller ID, type (`PROMOTED_LISTING`, `AI_BULK_CREDITS`), item/batch reference, amount, entitlement, start/end or remaining credits, payment reference, status.
- `sellerLedger/{entryId}`: seller ID, order/adjustment reference, signed amount, currency, type, immutable creation timestamp.
- `sellerPayouts/{payoutId}`: seller ID, amount, currency, destination reference (stored securely), status, approver, provider reference, timestamps.
- `marketplaceReports/{reportId}` and `sellerMessages/{threadId}/messages/{messageId}` only in a later phase with authorization, moderation, retention, and abuse controls.

Collection names and fields are a proposal; inspect existing Firestore rules and data contracts before implementing migrations.

## Payment and security rules

- A payment callback must be verified by the existing provider reconciliation path; never grant a plan, promotion, or bulk credits from a browser success message.
- Use idempotent payment references and Firestore transactions for entitlements/credits so callback retries cannot grant duplicates.
- Server routes derive the signed-in UID from the verified token and derive seller ID from the database.
- Validate uploaded file types, sizes, image URLs, product fields, listing quotas, and promotion eligibility on the server.
- Keep admin-only upload, moderation, payment, and payout routes admin-only.
- Do not change the existing first-party checkout, refunds, inventory, or admin behavior as part of the initial seller-onboarding milestone.

## Release gates

1. Unit tests for application state transitions, seller ownership, listing limits, promotion expiry, and idempotent credit grants.
2. API/type/build checks and security review for every new route.
3. Preview-only test seller and test products; test rejected, approved, suspended, and expired-plan states.
4. Payment-provider sandbox/controlled test before enabling money collection.
5. Admin approval and operational rollback plan before production launch.
