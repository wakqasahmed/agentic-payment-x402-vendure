import { describe, expect, it, vi } from 'vitest';
import type { ConfigArg } from '@vendure/common/lib/generated-types';
import type { ActiveOrderService, Order, PaymentMethod, PaymentMethodService, RequestContext } from '@vendure/core';

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

function makeResolver(args: ConfigArg[]) {
  const activeOrderService = {
    getActiveOrder: vi.fn().mockResolvedValue({ currencyCode: 'USD', totalWithTax: 1099 } as Order),
  } as unknown as ActiveOrderService;
  const paymentMethodService = {
    getMethodAndOperations: vi.fn().mockResolvedValue({
      paymentMethod: { handler: { args } } as PaymentMethod,
    }),
  } as unknown as PaymentMethodService;
  return new X402Resolver(activeOrderService, paymentMethodService);
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
});
