---
"vendure-payment-x402": patch
---

Validate the client-supplied `paymentPayload` shape and check it actually matches the server-built requirements (scheme/network/asset/payTo/amount), and cap its size, before forwarding anything to the facilitator. Previously a malformed or amount-mismatched payload was forwarded as-is, relying entirely on the facilitator to catch the problem server-side.
