# PrintPay B2C seller payouts — integration foundation

## Current state

The PrintPay B2C adapter exists at `api/_lib/printpay-b2c.js`, but is intentionally **not connected to seller payout requests or admin routes**. No live transfer is initiated by this change.

The current marketplace payout workflow remains unchanged until the provider verification and fee rules below are confirmed.

## Configuration

Add these as **server-side Vercel environment variables** when the integration is ready:

- `PRINTPAY_WALLET_ID` — PrintPay B2C wallet ID.
- `PRINTPAY_SECURITY_CREDENTIAL` — PrintPay B2C security credential.
- `PRINTPAY_B2C_PIN` — PIN required by the documented B2C withdrawal request.

Do not place these values in frontend environment variables, source code, logs, or client responses. Keep the existing `PRINTPAY_API_KEY` for buyer payments unchanged; it is a separate integration credential.

## Provider request

The adapter uses the documented endpoint `POST https://printpay.site/b2c/payout/withdraw` and `command_id: BusinessPayment`. It normalizes Kenyan phone numbers and validates the payout ID and whole-KSh amount before the request.

A successful response currently means **initialization accepted**, not confirmed M-Pesa delivery. The adapter returns `finalStatusVerified: false`; it does not mark the payout paid and does not write a seller-ledger debit.

## Required before wiring into production

Ask PrintPay support to confirm these details in writing:

1. Final payout result/status endpoint, including the request identifier and exact terminal status values.
2. Callback payload schema and how callback authenticity is verified (signature algorithm/header or another supported authentication method).
3. Whether a provider reference can be supplied by Herstepp and echoed back for reliable matching.
4. A fee quote endpoint or exact fee schedule. The example says the provider debits amount plus fee, but no reliable pre-transfer fee calculation is documented. Seller-paid fees must be shown before confirmation and included in balance validation.
5. Failure/reversal behavior, callback retries, and how to safely reconcile a timeout where the initiation outcome is unknown.

## Required production state machine

- Create and reserve one unique payout record before attempting provider initiation.
- Use the payout document ID as the stable internal correlation key; prevent a second initiation for the same payout.
- Never blindly retry after a timeout or malformed provider response. Reconcile with PrintPay first.
- Keep the payout pending after initialization.
- Accept only authenticated, validated final provider results; match payout ID/reference, seller, phone, amount, and currency.
- On confirmed success, atomically create one deterministic immutable negative ledger entry and mark the payout paid.
- On confirmed failure, release the reservation only when PrintPay confirms no transfer occurred or the funds were reversed.
- Deduplicate repeated callbacks and write audit events.
- Keep an operational reconciliation path for unknown outcomes.

## Safety gate

Do not connect the adapter to the seller-facing request route or enable automatic live transfers until items 1–5 are implemented and tested. The provider's initialization message alone is insufficient evidence to debit seller earnings or tell the seller that funds arrived.
