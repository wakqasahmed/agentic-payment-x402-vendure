# vendure-payment-x402

## 0.2.1

### Patch Changes

- 733c5a6: Fix `0.2.0` being published with no `dist/` directory -- the Release workflow ran `changeset publish` directly after `npm ci`, never running `npm run build`, so there was nothing for npm to pack. `require()`/`import()` both failed for anyone who installed `0.2.0`. Added the missing `npm run build` step to the workflow, plus a `prepublishOnly` script as a safety net against this recurring.

## 0.2.0

### Minor Changes

- f4defa6: Add a configurable `facilitatorTimeoutSeconds` arg (default 30s) and bound both `createPayment`'s and `settlePayment`'s facilitator HTTP calls with it. Previously a black-holed or slow facilitator hung the request/job indefinitely with no operator-visible signal.

### Patch Changes

- f7a906a: Apply the documented defaults for `pegCurrencyDecimals`, `scheme`, and `maxTimeoutSeconds` when an admin leaves them unset in the Admin UI. Vendure doesn't fall back to a config arg's `defaultValue` on its own; previously an unset `pegCurrencyDecimals` produced a `NaN` amount and a confusing decline message.
- 13fe527: Auto-settle x402 payments as soon as they reach `Authorized`, instead of relying on a manual Admin API `settlePayment` call. This closes a real failure mode: the x402 authorization's `maxTimeoutSeconds` validity window could lapse before an admin settled it manually, causing the facilitator to reject settlement as expired and stranding the order.

  Ownership is determined by the PaymentMethod's _handler_ code rather than its own (merchant-configurable) code, so this works regardless of what a store names its x402 PaymentMethod. If the auto-settle attempt fails, the outcome is logged via Vendure's `Logger`; when the facilitator rejects the settlement, the Payment is also transitioned to `Error` with the failure reason recorded, so it's visibly wrong to an admin rather than silently stuck at `Authorized`.

- f12b1c7: Fix `cancelPayment` reporting success after a payment has already settled on-chain. x402 exact-scheme settlements are irreversible token transfers with no refund path, so cancelling a `Settled` payment now returns a clear error instead of silently marking it `Cancelled` while the buyer's funds are still gone.
- 913bac4: Ship a dual CommonJS+ESM build instead of ESM-only. `require('vendure-payment-x402')` previously threw `ERR_REQUIRE_ESM` on a standard CommonJS Vendure scaffold (Node <22.12). Also declares `engines.node >= 20.0.0`.
- 0bc5391: Fixed two bugs found by live e2e testing against a real facilitator: `resolver.ts` advertised `x402Version: 1` while quoting a CAIP-2 network id, which current x402 client SDKs reject during scheme/network matching; and `buildPaymentRequirements` always sent `extra: {}`, so the facilitator rejected every EIP-3009 `transferWithAuthorization` payment with `invalid_exact_evm_missing_eip712_domain`, even correctly-signed ones.

  Adds required `assetName`/`assetVersion` args to the `x402` payment method handler, threaded into `extra` when building requirements for the facilitator. **Existing `x402` `PaymentMethod`s must be reconfigured with these two new args before accepting further payments** — the handler now declines with an explicit error naming the missing args instead of silently reverting to the empty-`extra` bug this fixes, and the `activeOrderX402PaymentRequirements` Shop API query throws a matching actionable error rather than a generic GraphQL null-field error.

  The Shop API's `activeOrderX402PaymentRequirements` query now nests the EIP-712 domain under `extra { name version }` (mirroring the wire shape sent to the facilitator, and `@x402/core`'s `PaymentRequirementsV2Schema`) instead of two disconnected flat `assetName`/`assetVersion` fields.

- 5094137: Make `settlePayment` idempotent against being invoked twice for the same payment (an admin double-click, retried event delivery, or a duplicate auto-settle event). Re-calling the facilitator with an already-settled payload previously turned a successful settlement into a spurious error and discarded the recorded settlement metadata.
- f88f5b4: Fix several low-severity issues: `transactionId` no longer set to the payer address at `Authorized` (was making every order from the same wallet share a `Payment.transactionId`); raw facilitator error responses are no longer relayed verbatim to anonymous Shop API callers; `network` is validated as a well-formed CAIP-2 identifier in both `createPayment` and the requirements query; the requirements query now quotes the outstanding balance (netting other payments and settled refunds) instead of the full order total; and a corrupted numeric config value no longer crashes the requirements query with an unhandled 500.
- ac95d44: Validate the client-supplied `paymentPayload` shape and check it actually matches the server-built requirements (scheme/network/asset/payTo/amount), and cap its size, before forwarding anything to the facilitator. Previously a malformed or amount-mismatched payload was forwarded as-is, relying entirely on the facilitator to catch the problem server-side.
- f4c2410: Decline zero-amount payments before calling the facilitator. A fully-discounted order, or the remaining-balance case on a partially-paid order, could reach `createPayment` with `amount === 0`; a facilitator that only checks `signedValue >= requiredAmount` would treat almost any payload as satisfying a $0 requirement.
