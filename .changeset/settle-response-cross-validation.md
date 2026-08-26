---
"vendure-payment-x402": patch
---

Fix `settlePayment`'s facilitator response cross-validation (#37): compare `network`/`amount` against `stored.requirements` (the values actually frozen and sent to `/settle` at authorize time), not the live `args` config, so an admin editing this payment method's config between authorize and settle no longer produces a false-positive mismatch on money that has already moved on-chain. Make the amount check scheme-aware and use a `BigInt` comparison instead of string equality: `exact` still requires an equal settled amount, while `upto` (and other partial-settlement schemes) now correctly accepts any settled amount up to the authorized maximum instead of always failing. On a mismatch, the settlement's transaction hash is now still recorded in `payment.metadata` before returning `success: false`, so the audit trail isn't lost and the idempotency short-circuit / `cancelPayment` can still recognize that funds already moved.
