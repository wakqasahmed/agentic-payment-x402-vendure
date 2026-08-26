---
"vendure-payment-x402": patch
---

Log the on-chain settlement tx hash the instant the facilitator confirms it, before returning to Vendure's `PaymentService.settlePayment` -- which is the call that actually persists `payment.metadata`/state, and can fail (DB blip, deadlock) after settlement has already irreversibly moved funds. Previously that tx hash existed nowhere durable if that downstream write failed. Documented the remaining gap (a retried settlement after that kind of failure re-submits to the facilitator, and this plugin can't verify what a given facilitator reports for an already-settled payload without live e2e testing) in the README.
