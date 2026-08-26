# vendure-payment-x402

An [x402](https://x402.org) stablecoin payment method for [Vendure](https://vendure.io) — lets AI shopping agents (and any x402-aware client) pay for Vendure orders directly, without a card or a traditional checkout UI.

No x402 payment integration exists for Vendure or Saleor — this package fills that gap for Vendure. Medusa has had one for longer ([`@financedistrict/medusa-plugin-prism-payment`](https://www.npmjs.com/package/@financedistrict/medusa-plugin-prism-payment)).

> **Corrected 25 July 2026.** An earlier version of this note also claimed no x402 integration existed for WooCommerce or Shopify. That is no longer accurate for WooCommerce. Several x402-capable plugins are now listed on WordPress.org — including [`claw-pay-gateway`](https://wordpress.org/plugins/claw-pay-gateway/) and [`instant-crypto-payments-for-woocommerce`](https://wordpress.org/plugins/instant-crypto-payments-for-woocommerce/) — all recent, and all with active-install counts still below the threshold WordPress.org publishes.
>
> WooCommerce core also ships its own ACP-shaped Agentic Checkout API now (verified against 10.9.4 and `trunk` on 25 July 2026). It is not open to third-party settlement rails: every agentic route requires Jetpack blog token authentication, and `CheckoutSessionsComplete` constrains the payment `provider` field to `'enum' => [ 'stripe' ]`. So a non-Stripe provider cannot currently complete a core agentic checkout session, even though the underlying `PaymentGatewayFeature::AGENTIC_COMMERCE` gateway-selection loop is itself provider-agnostic.

## How it maps onto Vendure

x402's protocol has a natural two-step shape — `verify` (check a signed payment is well-formed, no funds move) then `settle` (broadcast it) — which lines up cleanly with Vendure's `Authorized` → `Settled` payment states:

| Vendure | x402 |
|---|---|
| `createPayment` (→ `Authorized`) | facilitator `verify` |
| `settlePayment` (→ `Settled`) | facilitator `settle` |
| `cancelPayment` | no-op (nothing settled yet, so nothing to undo) |
| `createRefund` | *omitted* — see [Known limitations](#known-limitations) |

`createPayment` only verifies (no funds move) because the x402 authorization the buyer signed carries a short validity window (`maxTimeoutSeconds`, default 300s — for the `exact` EVM scheme this is the EIP-3009 `validBefore` baked into the signature itself). Rather than requiring an admin to click "Settle" within that window, this plugin auto-settles: see [Auto-settle](#auto-settle-authorized--settled).

## Setup

```sh
npm install vendure-payment-x402
```

```ts
import { X402Plugin } from 'vendure-payment-x402';

plugins: [
  X402Plugin.init(),
  // ...
]
```

Then create a PaymentMethod in the Admin UI using the **x402** handler and configure:

| Arg | Example | Meaning |
|---|---|---|
| `payToAddress` | `0xYourMerchantWallet` | Where settled funds land |
| `network` | `eip155:8453` | CAIP-2 network id (e.g. Base) |
| `asset` | `0x833589...2913` | Stablecoin contract/mint address |
| `assetDecimals` | `6` | Decimals of that asset (6 for USDC) |
| `assetName` | `USDC` | The asset contract's EIP-712 domain `name` — required to sign/verify the EIP-3009 `transferWithAuthorization` typed data |
| `assetVersion` | `2` | The asset contract's EIP-712 domain `version` (`2` for USDC) |
| `pegCurrencyCode` | `USD` | ISO 4217 currency the asset is assumed 1:1 pegged to |
| `pegCurrencyDecimals` | `2` | Decimals Vendure stores that currency in |
| `facilitatorUrl` | *(optional)* | Defaults to the public `x402.org` facilitator (testnet-only — use a production facilitator, or run your own, for mainnet) |

Orders in any currency other than `pegCurrencyCode` are rejected by this payment method at both the quoting query and `createPayment` — there's no FX conversion, only a 1:1 peg assumption.

## Storefront / agent flow

There's no server-issued "client secret" the way Stripe works. Instead:

1. Query the Shop API for payment requirements:
   ```graphql
   query {
     activeOrderX402PaymentRequirements {
       x402Version
       scheme
       network
       asset
       extra { name version }
       amount
       payTo
       maxTimeoutSeconds
     }
   }
   ```
2. Sign a matching payment client-side with an x402-aware wallet/SDK — `@x402/evm` or `@x402/svm` depending on the network. (This plugin only depends on `@x402/core`; the buyer's client needs the chain-specific signing package, not the merchant server.)
3. Submit it:
   ```graphql
   mutation {
     addPaymentToOrder(input: {
       method: "x402",
       metadata: { paymentPayload: <the signed payload from step 2> }
     }) { ... }
   }
   ```
4. Vendure calls `createPayment`, which verifies the payload with the facilitator and transitions the Payment to `Authorized`. No funds have moved yet.

## Auto-settle (`Authorized` → `Settled`)

Vendure itself has no built-in path from `Authorized` to `Settled` — `settlePayment` is normally only invoked by an admin via the Admin API. Left alone, that's a problem for x402: the authorization's validity window (`maxTimeoutSeconds`) can lapse before a human gets to it, and the facilitator will then reject the settlement as expired even though the buyer's agent already believes it paid.

To close that gap, this plugin subscribes to Vendure's `PaymentStateTransitionEvent` and, the moment a Payment backed by the **x402** handler reaches `Authorized`, calls `settlePayment` itself — well inside `maxTimeoutSeconds`, with no admin action required. This keeps the two-step verify/settle model (an admin can still manually settle or retry through the Admin API if needed) while making the common case fully automatic. Ownership is determined by resolving the Payment's PaymentMethod entity and checking its *handler* code, not the PaymentMethod's own (merchant-configurable) `code` — so this works no matter what you name the PaymentMethod in the Admin UI, and won't misfire for an unrelated PaymentMethod that happens to share a code with this handler.

**If the auto-settle attempt fails, this plugin makes the failure visible — but the Payment is not guaranteed to leave `Authorized` in every case.**

- If the facilitator rejects the settlement, Vendure's own `PaymentService.settlePayment` transitions the Payment to `Error` and records the failure reason as `payment.errorMessage`, visible on the order in the Admin UI. This plugin also logs the outcome via Vendure's `Logger` (tagged `x402`).
- If `settlePayment` instead returns an error result *without* moving the Payment out of `Authorized` (e.g. the `Error` state transition itself is rejected), or an unexpected error is thrown (network/DB error), the Payment **can** remain at `Authorized`. This plugin logs these cases explicitly via `Logger.error` (tagged `x402`) so they show up in server logs, but resolving them still requires an admin to intervene manually.

The plugin also guards against the state-transition event firing more than once for the same Payment (the event bus can in principle redeliver): it tracks in-flight settlement attempts per Payment ID and re-checks the Payment's current state immediately before calling `settlePayment`, so a duplicate event can't trigger a second settlement attempt once the first has started or finished.

## Known limitations

- **No recovery across an app restart.** The event subscription is live-only: a Payment that reaches `Authorized` in the moments around a deploy, crash, or worker restart is not picked up retroactively — no event fires for it. It sits at `Authorized` until an admin settles it manually or it lapses past `maxTimeoutSeconds`. A startup reconciliation sweep would close this gap but is out of scope for this release.
- **No automated refunds.** x402 `exact`-scheme settlements are on-chain token transfers; the protocol has no facilitator-side reversal endpoint, and this plugin never holds merchant private keys to construct one itself. `createRefund` is intentionally omitted — per Vendure's own `PaymentMethodHandler` docs, omitting it means refunds are settled manually by an administrator, which is correct here, not a missing feature.
- **Single full-order payment only.** The requirements query quotes `order.totalWithTax`; split/partial payments across multiple methods aren't accounted for.
- **1:1 peg assumption, no FX.** `pegCurrencyCode`/`pegCurrencyDecimals` are explicit configuration because Vendure doesn't expose a public per-currency decimals table to plugins — there's no automatic ISO 4217 lookup, and no price-oracle conversion for non-pegged assets.
- **`assetName`/`assetVersion` are required, not optional.** EIP-3009 `transferWithAuthorization` signing/verification needs the asset contract's own EIP-712 domain to reconstruct the signed typed-data hash. Omitting these makes the facilitator reject every payment with `invalid_exact_evm_missing_eip712_domain`, even when the buyer signed correctly — this was caught by e2e testing against a live facilitator, not by the unit tests, since the mocked facilitator doesn't validate signatures.

E2e-verified against a real Vendure server + Postgres + the public `x402.org` facilitator on Base Sepolia testnet: a signed EIP-3009 USDC payment cleared `verify` and `settle`, the Order reached `PaymentSettled`, and the transfer landed on-chain.

## Development

```sh
npm install
npm run typecheck
npm run lint
npm run test
npm run build   # tsc, not esbuild/tsup — NestJS's emitDecoratorMetadata
                # needs the real TS compiler; esbuild silently drops it
```
