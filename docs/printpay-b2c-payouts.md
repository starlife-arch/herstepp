# PrintPay B2C seller payouts — integration foundation

## Current state

The adapter exists at `api/_lib/printpay-b2c.js` on branch `feat/printpay-b2c-payout-foundation`. It now supports the documented wallet-balance request and payout initiation, and parses the dynamic fee breakdown when PrintPay includes the documented message format.

It is **not connected to seller payout requests or admin routes**. No live transfer is initiated by this change.

## Configuration

When preparing a controlled test, add these as server-side Vercel environment variables:

- `PRINTPAY_WALLET_ID` — PrintPay B2C wallet ID.
- `PRINTPAY_SECURITY_CREDENTIAL` — PrintPay B2C security credential.
- `PRINTPAY_B2C_PIN` — PIN required by the documented B2C withdrawal request.

Do not place these values in frontend environment variables, source code, logs, or client responses. Keep the existing `PRINTPAY_API_KEY` for buyer payments unchanged; it is a separate integration credential.

## Documented provider operations

- Wallet balance: `POST https://printpay.site/b2c/walletbalance`
- B2C withdrawal: `POST https://printpay.site/b2c/payout/withdraw`
- Withdrawal command: `BusinessPayment`
- Auth headers: `X-Wallet-ID`, `X-Security-Credential`

The adapter normalizes Kenyan phone numbers, validates the internal payout ID and whole-KSh amount, and keeps the PIN server-side.

## Fee handling

PrintPay's example response reports a total wallet debit and a dynamic fee, e.g. amount KES 1,000 plus fee KES 14. The adapter extracts this breakdown if the response follows that format. It does not guess the fee when the message format differs.

**Important:** the fee is disclosed in the response after initiation, not in a documented quote endpoint. Before enabling automatic transfers, the seller must explicitly agree that the provider fee is added to their deduction, and the payout workflow must reserve enough funds to cover the provider fee without allowing a negative balance. If Herstepp needs to show the exact fee before confirmation, PrintPay must provide a quote or fee schedule.

## Final payout status

The documentation supplied shows the result webhook URL `https://printpay.site/b2c/payout/result`, but does not specify the callback body, authenticity verification, correlation reference, or terminal success/failure fields. Therefore the adapter treats the response as **INITIALIZED**, not PAID. It does not mark a payout paid or write a seller-ledger debit.

A webhook URL alone is not sufficient to safely trust a callback. Before accepting callback results, obtain the exact payload and supported authenticity-verification mechanism from PrintPay, or use a documented provider status lookup if available.

## Required production state machine

- Create and reserve one unique payout record before attempting provider initiation.
- Prevent a second initiation for the same payout; use a stable internal payout ID for correlation.
- Check wallet balance and reserve both the seller payout amount and a safe fee allowance before dispatch.
- Never blindly retry after a timeout or malformed provider response. Reconcile with PrintPay first.
- Keep the payout pending after initialization.
- Accept only authenticated, validated final provider results; match the payout/reference, seller, phone, amount, and currency.
- On confirmed success, atomically create one deterministic immutable negative ledger entry for the **recipient amount plus seller-paid fee**, and mark the payout paid.
- On confirmed failure, release the reservation only when PrintPay confirms no transfer occurred or funds were reversed.
- Deduplicate repeated callbacks and write audit events.
- Keep an operational reconciliation path for unknown outcomes.

## Safety gate

Do not connect the adapter to the seller-facing request route or enable automatic live transfers until fee consent/reservation, final-result verification, idempotent ledger posting, failure/reversal handling, and reconciliation are implemented and tested. The provider's initialization message alone is insufficient evidence to debit seller earnings or tell the seller that funds arrived.
