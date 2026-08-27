import { Query, Resolver } from '@nestjs/graphql';
import {
  ActiveOrderService,
  Ctx,
  OrderService,
  PaymentMethodService,
  RequestContext,
  UserInputError,
} from '@vendure/core';

import { toAtomicUnits } from './amount.js';
import { X402_PAYMENT_METHOD_CODE } from './constants.js';
import { isValidCaip2Network } from './network.js';
import { totalCoveredByPayments } from './order-total.js';
import { getRateLimitKey, requirementsRateLimiter } from './rate-limit.js';
import type { X402PaymentRequirementsResult } from './types.js';

/**
 * Raw `ConfigArg[]` -> plain `{ name: value }` object. This does NOT coerce
 * `int`-typed args to numbers -- every value stays a string here; `getInt`
 * below does the actual coercion (and validates it) per field.
 */
function argsToRecord(args: Array<{ name: string; value: string }>): Record<string, string> {
  return Object.fromEntries(args.map(arg => [arg.name, arg.value]));
}

const INT_ARGS = new Set(['assetDecimals', 'pegCurrencyDecimals', 'maxTimeoutSeconds']);
const STRING_ARGS = new Set(['payToAddress', 'network', 'asset', 'assetName', 'assetVersion']);

@Resolver()
export class X402Resolver {
  constructor(
    private activeOrderService: ActiveOrderService,
    private paymentMethodService: PaymentMethodService,
    private orderService: OrderService,
  ) {}

  @Query()
  async activeOrderX402PaymentRequirements(
    @Ctx() ctx: RequestContext,
  ): Promise<X402PaymentRequirementsResult> {
    // Anonymous Shop API callers can hit this repeatedly for free -- gate it
    // locally before doing any DB work. See rate-limit.ts for the fail-open
    // rationale and key derivation.
    if (!requirementsRateLimiter.consume(getRateLimitKey(ctx))) {
      throw new UserInputError('Too many requests. Please try again shortly.');
    }

    const order = await this.activeOrderService.getActiveOrder(ctx, undefined);
    if (!order) {
      throw new UserInputError('No active order found for session');
    }

    // The PaymentMethod entity's own `code` is merchant-configurable and
    // independent of the handler code (a store can name it anything), so we
    // find the enabled method actually backed by the x402 handler rather
    // than assuming a PaymentMethod named "x402" exists.
    const activePaymentMethods = await this.paymentMethodService.getActivePaymentMethods(ctx);
    const x402PaymentMethods = activePaymentMethods.filter(
      method => method.handler.code === X402_PAYMENT_METHOD_CODE,
    );
    if (x402PaymentMethods.length === 0) {
      throw new UserInputError('No enabled x402 payment method is configured for this channel');
    }
    if (x402PaymentMethods.length > 1) {
      throw new UserInputError(
        'Multiple enabled x402 payment methods are configured for this channel; ' +
          'this query does not yet support selecting between them',
      );
    }
    const paymentMethod = x402PaymentMethods[0];
    const args = argsToRecord(paymentMethod.handler.args);
    const getInt = (name: string): number => {
      const raw = args[name];
      if (!INT_ARGS.has(name) || raw === undefined) {
        throw new Error(`Expected configured int arg "${name}" on the x402 payment method`);
      }
      const value = Number(raw);
      if (Number.isNaN(value)) {
        throw new Error(
          `Configured value "${raw}" for "${name}" on the x402 payment method is not a valid number. ` +
            'Reconfigure this payment method in the Admin UI.',
        );
      }
      return value;
    };
    const getString = (name: string): string => {
      const raw = args[name];
      if (!STRING_ARGS.has(name) || !raw) {
        throw new Error(
          `Expected configured arg "${name}" on the x402 payment method. Reconfigure this ` +
            'payment method in the Admin UI to set it.',
        );
      }
      return raw;
    };

    if (order.currencyCode !== args.pegCurrencyCode) {
      throw new UserInputError(
        `Order currency ${order.currencyCode} is not accepted by the x402 payment method ` +
          `(configured for ${args.pegCurrencyCode}).`,
      );
    }

    const network = getString('network');
    if (!isValidCaip2Network(network)) {
      throw new Error(
        `x402 payment method is misconfigured: "network" ("${network}") is not a valid CAIP-2 ` +
          'identifier (e.g. "eip155:8453"). Reconfigure this payment method in the Admin UI.',
      );
    }

    // Quote the outstanding balance, not the order total -- after any partial
    // payment (a different method, a gift card, etc.) the order total alone
    // over-quotes what's actually still owed. This re-fetches the order with
    // its payments relation since ActiveOrderService's result doesn't load it.
    const orderWithPayments = await this.orderService.findOne(ctx, order.id, ['payments', 'payments.refunds']);
    const outstandingBalance =
      order.totalWithTax - totalCoveredByPayments((orderWithPayments ?? order).payments ?? []);

    const amount = toAtomicUnits(
      Math.max(outstandingBalance, 0),
      getInt('pegCurrencyDecimals'),
      getInt('assetDecimals'),
    );

    return {
      // CAIP-2 network identifiers (e.g. "eip155:84532") are a v2 x402 concept --
      // an x402Version of 1 alongside a CAIP-2 network fails scheme/network
      // matching in current client SDKs (confirmed against @x402/core@2.19.0).
      x402Version: 2,
      scheme: args.scheme || 'exact',
      network,
      asset: getString('asset'),
      extra: { name: getString('assetName'), version: getString('assetVersion') },
      amount,
      payTo: getString('payToAddress'),
      maxTimeoutSeconds: getInt('maxTimeoutSeconds'),
    };
  }
}
