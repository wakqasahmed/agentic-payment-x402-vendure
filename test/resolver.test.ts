import { describe, expect, it, vi } from 'vitest';
import type { ConfigArg } from '@vendure/common/lib/generated-types';
import type {
  ActiveOrderService,
  Order,
  OrderService,
  PaymentMethod,
  PaymentMethodService,
  RequestContext,
} from '@vendure/core';

import { X402_PAYMENT_METHOD_CODE } from '../src/constants.js';
import { X402Resolver } from '../src/resolver.js';

const ctx = undefined as unknown as RequestContext;

function configArgs(overrides: Record<string, string | undefined> = {}): ConfigArg[] {
  const defaults: Record<string, string | undefined> = {
    payToAddress: '0xMerchant',
    network: 'eip155:8453',
    asset: '0xUSDC',
    assetDecimals: '6',
    assetName: 'USDC',
    assetVersion: '2',
    pegCurrencyCode: 'USD',
    pegCurrencyDecimals: '2',
    scheme: 'exact',
    maxTimeoutSeconds: '300',
    ...overrides,
  };
  return Object.entries(defaults)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, value]) => ({ name, value }) as ConfigArg);
}

function makeResolver(
  args: ConfigArg[],
  opts: { order?: Partial<Order>; payments?: Array<Record<string, unknown>> } = {},
) {
  const order = { currencyCode: 'USD', totalWithTax: 1099, id: 'order-1', ...opts.order } as Order;
  const activeOrderService = {
    getActiveOrder: vi.fn().mockResolvedValue(order),
  } as unknown as ActiveOrderService;
  const paymentMethodService = {
    getActivePaymentMethods: vi.fn().mockResolvedValue([
      { handler: { code: X402_PAYMENT_METHOD_CODE, args } } as unknown as PaymentMethod,
    ]),
  } as unknown as PaymentMethodService;
  const orderService = {
    findOne: vi.fn().mockResolvedValue({ ...order, payments: opts.payments ?? [] }),
  } as unknown as OrderService;
  return new X402Resolver(activeOrderService, paymentMethodService, orderService);
}

describe('X402Resolver.activeOrderX402PaymentRequirements', () => {
  it('returns requirements with the EIP-712 domain nested under extra', async () => {
    const resolver = makeResolver(configArgs());
    const result = await resolver.activeOrderX402PaymentRequirements(ctx);

    expect(result.x402Version).toBe(2);
    expect(result.extra).toEqual({ name: 'USDC', version: '2' });
  });

  it('throws an actionable error when assetName is missing from the payment method config', async () => {
    const resolver = makeResolver(configArgs({ assetName: undefined }));

    await expect(resolver.activeOrderX402PaymentRequirements(ctx)).rejects.toThrow(/assetName/);
  });

  it('throws an actionable error when assetVersion is missing from the payment method config', async () => {
    const resolver = makeResolver(configArgs({ assetVersion: undefined }));

    await expect(resolver.activeOrderX402PaymentRequirements(ctx)).rejects.toThrow(/assetVersion/);
  });

  it('throws a clear error when a configured int arg is not a valid number', async () => {
    const resolver = makeResolver(configArgs({ maxTimeoutSeconds: 'not-a-number' }));

    await expect(resolver.activeOrderX402PaymentRequirements(ctx)).rejects.toThrow(/not a valid number/);
  });

  it('throws a clear error when network is not a valid CAIP-2 identifier', async () => {
    const resolver = makeResolver(configArgs({ network: 'base' }));

    await expect(resolver.activeOrderX402PaymentRequirements(ctx)).rejects.toThrow(/CAIP-2/);
  });

  it('quotes the outstanding balance, not the order total, after a partial payment', async () => {
    // $10.99 order (1099 cents) with a $5.00 (500 cents) payment already covering it.
    const resolver = makeResolver(configArgs(), {
      order: { totalWithTax: 1099 },
      payments: [{ state: 'Settled', amount: 500, refunds: [] }],
    });

    const result = await resolver.activeOrderX402PaymentRequirements(ctx);

    // (1099 - 500) cents at pegCurrencyDecimals=2 -> assetDecimals=6: 599 * 10^4
    expect(result.amount).toBe('5990000');
  });

  it('nets out settled refunds when computing the outstanding balance', async () => {
    const resolver = makeResolver(configArgs(), {
      order: { totalWithTax: 1099 },
      payments: [{ state: 'Settled', amount: 1099, refunds: [{ state: 'Settled', total: 1099 }] }],
    });

    const result = await resolver.activeOrderX402PaymentRequirements(ctx);

    // Fully refunded -> outstanding balance is back to the full order total.
    expect(result.amount).toBe('10990000');
  });
});
