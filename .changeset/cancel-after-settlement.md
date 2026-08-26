---
"vendure-payment-x402": patch
---

Fix `cancelPayment` reporting success after a payment has already settled on-chain. x402 exact-scheme settlements are irreversible token transfers with no refund path, so cancelling a `Settled` payment now returns a clear error instead of silently marking it `Cancelled` while the buyer's funds are still gone.
