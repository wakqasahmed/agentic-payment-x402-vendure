import { gql } from 'graphql-tag';
import { PluginCommonModule, VendurePlugin } from '@vendure/core';

import { x402PaymentMethodHandler } from './handler.js';
import { X402Resolver } from './resolver.js';

/**
 * Adds the x402 stablecoin payment method to Vendure.
 *
 * ## Setup
 *
 * ```ts
 * import { X402Plugin } from 'vendure-payment-x402';
 *
 * plugins: [
 *   X402Plugin.init(),
 * ]
 * ```
 *
 * Then create a PaymentMethod in the Admin UI using the "x402" handler, and
 * configure its pay-to address, network, asset, and peg currency.
 *
 * ## Storefront / agent usage
 *
 * 1. Query `activeOrderX402PaymentRequirements` (added to the Shop API) to
 *    get the x402 `PaymentRequirements` for the active order.
 * 2. Sign a matching payment client-side with an x402-aware wallet/SDK
 *    (e.g. `@x402/evm` or `@x402/svm` — this plugin only depends on
 *    `@x402/core`, since signing happens on the buyer's side, not the
 *    merchant server's).
 * 3. Call `addPaymentToOrder(input: { method: "x402", metadata: { paymentPayload: <signed payload> } })`.
 *
 * See the package README for the full flow and known limitations
 * (single full-order payments only, no automated refunds).
 */
@VendurePlugin({
  imports: [PluginCommonModule],
  configuration: config => {
    config.paymentOptions.paymentMethodHandlers.push(x402PaymentMethodHandler);
    return config;
  },
  shopApiExtensions: {
    schema: gql`
      type X402PaymentRequirements {
        x402Version: Int!
        scheme: String!
        network: String!
        asset: String!
        assetName: String!
        assetVersion: String!
        amount: String!
        payTo: String!
        maxTimeoutSeconds: Int!
      }

      extend type Query {
        activeOrderX402PaymentRequirements: X402PaymentRequirements!
      }
    `,
    resolvers: [X402Resolver],
  },
  compatibility: '^3.0.0',
})
export class X402Plugin {
  static init(): typeof X402Plugin {
    return X402Plugin;
  }
}
