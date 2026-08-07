---
"vendure-payment-x402": patch
---

Auto-settle x402 payments as soon as they reach `Authorized`, instead of relying on a manual Admin API `settlePayment` call. This closes a real failure mode: the x402 authorization's `maxTimeoutSeconds` validity window could lapse before an admin settled it manually, causing the facilitator to reject settlement as expired and stranding the order. If the auto-settle attempt itself fails, the Payment transitions to `Error` with the facilitator's failure reason recorded, so it's visibly wrong to an admin instead of silently stuck at `Authorized`.
