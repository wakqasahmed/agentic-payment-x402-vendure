---
"vendure-payment-x402": patch
---

Decline zero-amount payments before calling the facilitator. A fully-discounted order, or the remaining-balance case on a partially-paid order, could reach `createPayment` with `amount === 0`; a facilitator that only checks `signedValue >= requiredAmount` would treat almost any payload as satisfying a $0 requirement.
