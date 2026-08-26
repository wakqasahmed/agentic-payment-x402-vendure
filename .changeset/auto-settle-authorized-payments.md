---
"vendure-payment-x402": patch
---

Auto-settle x402 payments as soon as they reach `Authorized`, instead of relying on a manual Admin API `settlePayment` call. This closes a real failure mode: the x402 authorization's `maxTimeoutSeconds` validity window could lapse before an admin settled it manually, causing the facilitator to reject settlement as expired and stranding the order.

Ownership is determined by the PaymentMethod's *handler* code rather than its own (merchant-configurable) code, so this works regardless of what a store names its x402 PaymentMethod. If the auto-settle attempt fails, the outcome is logged via Vendure's `Logger`; when the facilitator rejects the settlement, the Payment is also transitioned to `Error` with the failure reason recorded, so it's visibly wrong to an admin rather than silently stuck at `Authorized`.
