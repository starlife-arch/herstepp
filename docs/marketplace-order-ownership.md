# Marketplace order ownership and fulfilment

## Order ownership rules

- Orders containing only HerStep Collection products remain first-party orders. Admin may manage their normal fulfilment status.
- Orders containing only marketplace seller products are seller-managed. The seller updates their own fulfilment status from the seller dashboard. Admin order-status mutation is rejected by the API; admin continues to handle moderation, reports, refunds, disputes, payment oversight, and payout review.
- Mixed baskets keep one customer checkout/payment record, but fulfilment status is split: the seller updates only their own lines through `sellerFulfilment[sellerUid]`, while admin may update only HerStep's lines through `firstPartyFulfilment`. A mixed basket cannot be cancelled through the global admin order-status action because that could affect a seller's lines; use the refund/dispute workflow for item-level exceptions.

## Seller fulfilment statuses

`PENDING → PROCESSING → PROCESSED → OUT_FOR_DELIVERY → DELIVERED`

Seller cancellation is not a normal fulfilment transition. A seller who cannot fulfil a paid order should contact marketplace support so the refund/dispute workflow can record the decision.

The seller orders endpoint discovers orders from that seller's own ledger entries, then filters each order's line items by seller ID. A seller receives only their own product lines and the buyer/delivery details needed to fulfil them. Customer tracking exposes each seller's fulfilment status separately.

## Earnings release

Seller earnings begin in the pending bucket after a verified payment. When that seller marks their own fulfilment delivered, the API computes the net pending ledger balance for that seller/order, then posts immutable signed entries to move that amount from pending to available. This must use the net pending balance, not gross line value, because refund adjustments may already have reduced pending earnings. Available earnings remain subject to refund holds. The action is idempotent through the status transition and deterministic ledger IDs; no automatic transfer is sent to M-Pesa.

## Admin boundaries

- Admin cannot change the fulfilment status of a pure marketplace seller order.
- For mixed baskets, admin status changes apply only to `firstPartyFulfilment`, not the order-wide status or seller lines.
- Admin payout controls approve/reject requests and record an external transfer only after the actual provider reference is available.
- Admin can still view order/payment records and use refund, report, moderation, and dispute controls.
