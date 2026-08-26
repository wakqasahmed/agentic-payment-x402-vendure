---
"vendure-payment-x402": patch
---

Fixed two bugs found by live e2e testing against a real facilitator: `resolver.ts` advertised `x402Version: 1` while quoting a CAIP-2 network id, which current x402 client SDKs reject during scheme/network matching; and `buildPaymentRequirements` always sent `extra: {}`, so the facilitator rejected every EIP-3009 `transferWithAuthorization` payment with `invalid_exact_evm_missing_eip712_domain`, even correctly-signed ones.

Adds required `assetName`/`assetVersion` args to the `x402` payment method handler, threaded into `extra` when building requirements for the facilitator. **Existing `x402` `PaymentMethod`s must be reconfigured with these two new args before accepting further payments** — the handler now declines with an explicit error naming the missing args instead of silently reverting to the empty-`extra` bug this fixes, and the `activeOrderX402PaymentRequirements` Shop API query throws a matching actionable error rather than a generic GraphQL null-field error.

The Shop API's `activeOrderX402PaymentRequirements` query now nests the EIP-712 domain under `extra { name version }` (mirroring the wire shape sent to the facilitator, and `@x402/core`'s `PaymentRequirementsV2Schema`) instead of two disconnected flat `assetName`/`assetVersion` fields.
