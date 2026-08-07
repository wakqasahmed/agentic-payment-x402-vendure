import type { OnApplicationBootstrap } from '@nestjs/common';
import { gql } from 'graphql-tag';
import {
  EventBus,
  Logger,
  OrderService,
  Payment,
  PaymentStateTransitionEvent,
  PluginCommonModule,
  TransactionalConnection,
  VendurePlugin,
} from '@vendure/core';
import type { ID } from '@vendure/core';
import { filter } from 'rxjs/operators';

import { X402_PAYMENT_METHOD_CODE } from './constants.js';
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
 * As soon as that Payment reaches `Authorized`, this plugin auto-settles it
 * (see README for the full event-driven flow and what happens on failure).
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
export class X402Plugin implements OnApplicationBootstrap {
  // In-flight guard against the state-transition event firing more than once
  // for the same Payment (the event bus can in principle re-deliver, and
  // handler.settlePayment is not itself idempotent -- see issue #13). This
  // only protects against concurrent double-dispatch; the Payment state
  // check in autoSettle below is what protects against a second event
  // arriving after the first attempt has already finished.
  private readonly settlingPaymentIds = new Set<ID>();

  constructor(
    private eventBus: EventBus,
    private orderService: OrderService,
    private connection: TransactionalConnection,
  ) {}

  static init(): typeof X402Plugin {
    return X402Plugin;
  }

  onApplicationBootstrap(): void {
    this.eventBus
      .ofType(PaymentStateTransitionEvent)
      .pipe(
        filter(
          event => event.payment.method === X402_PAYMENT_METHOD_CODE && event.toState === 'Authorized',
        ),
      )
      .subscribe(event => {
        void this.autoSettle(event);
      });
  }

  private async autoSettle(event: PaymentStateTransitionEvent): Promise<void> {
    const paymentId = event.payment.id;
    if (this.settlingPaymentIds.has(paymentId)) {
      return;
    }
    this.settlingPaymentIds.add(paymentId);
    try {
      const current = await this.connection.getEntityOrThrow(event.ctx, Payment, paymentId);
      if (current.state !== 'Authorized') {
        return;
      }
      // handler.settlePayment reports facilitator failures via
      // SettlePaymentErrorResult, which PaymentService turns into a Payment
      // transition to Error (with errorMessage set) rather than a thrown
      // error, so an admin sees the failure instead of a stranded Authorized
      // payment. This catch only guards against unexpected errors outside
      // that path (e.g. a DB error) so they can't crash the event subscriber.
      await this.orderService.settlePayment(event.ctx, paymentId);
    } catch (err) {
      Logger.error(
        `Auto-settle failed for x402 payment ${String(paymentId)}: ${(err as Error).message}`,
        X402_PAYMENT_METHOD_CODE,
      );
    } finally {
      this.settlingPaymentIds.delete(paymentId);
    }
  }
}
