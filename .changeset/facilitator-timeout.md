---
"vendure-payment-x402": minor
---

Add a configurable `facilitatorTimeoutSeconds` arg (default 30s) and bound both `createPayment`'s and `settlePayment`'s facilitator HTTP calls with it. Previously a black-holed or slow facilitator hung the request/job indefinitely with no operator-visible signal.
