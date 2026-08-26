---
"vendure-payment-x402": patch
---

Fix several low-severity issues: `transactionId` no longer set to the payer address at `Authorized` (was making every order from the same wallet share a `Payment.transactionId`); raw facilitator error responses are no longer relayed verbatim to anonymous Shop API callers; `network` is validated as a well-formed CAIP-2 identifier in both `createPayment` and the requirements query; the requirements query now quotes the outstanding balance (netting other payments and settled refunds) instead of the full order total; and a corrupted numeric config value no longer crashes the requirements query with an unhandled 500.
