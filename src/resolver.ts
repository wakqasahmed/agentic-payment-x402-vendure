import { Query, Resolver } from '@nestjs/graphql';
import {
  ActiveOrderService,
  Ctx,
  PaymentMethodService,
  RequestContext,
  UserInputError,
} from '@vendure/core';

import { toAtomicUnits } from './amount.js';
import { X402_PAYMENT_METHOD_CODE } from './constants.js';
import type { X402PaymentRequirementsResult } from './types.js';

/** Raw `ConfigArg[]` -> plain object, coercing the `int` fields this handler defines. */
function argsToRecord(args: Array<{ name: string; value: string }>): Record<string, string> {
  return Object.fromEntries(args.map(arg => [arg.name, arg.value]));
}

const INT_ARGS = new Set(['assetDecimals', 'pegCurrencyDecimals', 'maxTimeoutSeconds']);

@Resolver()
export class X402Resolver {
  constructor(
    private activeOrderService: ActiveOrderService,
    private paymentMethodService: PaymentMethodService,
  ) {}

  @Query()
  async activeOrderX402PaymentRequirements(
    @Ctx() ctx: RequestContext,
  ): Promise<X402PaymentRequirementsResult> {
    const order = await this.activeOrderService.getActiveOrder(ctx, undefined);
    if (!order) {
      throw new UserInputError('No active order found for session');
    }

    const { paymentMethod } = await this.paymentMethodService.getMethodAndOperations(
      ctx,
      X402_PAYMENT_METHOD_CODE,
    );
    const args = argsToRecord(paymentMethod.handler.args);
    const getInt = (name: string): number => {
      const raw = args[name];
      if (!INT_ARGS.has(name) || raw === undefined) {
        throw new Error(`Expected configured int arg "${name}" on the x402 payment method`);
      }
      return Number(raw);
    };

    if (order.currencyCode !== args.pegCurrencyCode) {
      throw new UserInputError(
        `Order currency ${order.currencyCode} is not accepted by the x402 payment method ` +
          `(configured for ${args.pegCurrencyCode}).`,
      );
    }

    const amount = toAtomicUnits(
      order.totalWithTax,
      getInt('pegCurrencyDecimals'),
      getInt('assetDecimals'),
    );

    return {
      x402Version: 1,
      scheme: args.scheme || 'exact',
      network: args.network,
      asset: args.asset,
      amount,
      payTo: args.payToAddress,
      maxTimeoutSeconds: getInt('maxTimeoutSeconds'),
    };
  }
}
