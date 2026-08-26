import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
import { x402PaymentMethodHandler } from '../src/handler.js';
import {
  DEFAULT_RATE_LIMIT,
  FixedWindowRateLimiter,
  configureX402RateLimit,
  createPaymentRateLimiter,
  getRateLimitKey,
  requirementsRateLimiter,
  resetX402RateLimiters,
} from '../src/rate-limit.js';
import { X402Resolver } from '../src/resolver.js';

const FACILITATOR_URL = 'https://facilitator.test';

function configArgs(overrides: Record<string, string> = {}): ConfigArg[] {
  const defaults: Record<string, string> = {
    facilitatorUrl: FACILITATOR_URL,
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
    facilitatorTimeoutSeconds: '30',
    ...overrides,
  };
  return Object.entries(defaults).map(([name, value]) => ({ name, value }));
}

const order = { currencyCode: 'USD', code: 'TEST-ORDER-1' } as Order;
const method = undefined as unknown as PaymentMethod;
const paymentPayload = {
  x402Version: 2,
  accepted: {
    scheme: 'exact',
    network: 'eip155:8453',
    asset: '0xUSDC',
    amount: '10000000',
    payTo: '0xMerchant',
    maxTimeoutSeconds: 300,
    extra: {},
  },
  payload: { signature: 'fake' },
} as unknown as Record<string, unknown>;

function ctxWithSession(token: string): RequestContext {
  return { session: { token } } as unknown as RequestContext;
}

describe('FixedWindowRateLimiter', () => {
  it('allows requests under the limit', () => {
    const limiter = new FixedWindowRateLimiter(() => ({ maxRequests: 3, windowMs: 1000 }));
    expect(limiter.consume('key')).toBe(true);
    expect(limiter.consume('key')).toBe(true);
    expect(limiter.consume('key')).toBe(true);
  });

  it('rejects requests once the limit is exceeded within the same window', () => {
    const limiter = new FixedWindowRateLimiter(() => ({ maxRequests: 2, windowMs: 1000 }));
    expect(limiter.consume('key')).toBe(true);
    expect(limiter.consume('key')).toBe(true);
    expect(limiter.consume('key')).toBe(false);
  });

  it('tracks separate keys independently', () => {
    const limiter = new FixedWindowRateLimiter(() => ({ maxRequests: 1, windowMs: 1000 }));
    expect(limiter.consume('a')).toBe(true);
    expect(limiter.consume('b')).toBe(true);
    expect(limiter.consume('a')).toBe(false);
    expect(limiter.consume('b')).toBe(false);
  });

  it('resets the window after it elapses', () => {
    vi.useFakeTimers();
    try {
      const limiter = new FixedWindowRateLimiter(() => ({ maxRequests: 1, windowMs: 1000 }));
      expect(limiter.consume('key')).toBe(true);
      expect(limiter.consume('key')).toBe(false);

      vi.advanceTimersByTime(999);
      expect(limiter.consume('key')).toBe(false);

      vi.advanceTimersByTime(2);
      expect(limiter.consume('key')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails open when the configured options getter throws', () => {
    const limiter = new FixedWindowRateLimiter(() => {
      throw new Error('boom');
    });
    expect(limiter.consume('key')).toBe(true);
  });
});

describe('getRateLimitKey', () => {
  it('keys by session token when present', () => {
    expect(getRateLimitKey(ctxWithSession('tok-1'))).toBe('session:tok-1');
  });

  it('keys by IP when there is no session token', () => {
    const ctx = { req: { ip: '203.0.113.5' } } as unknown as RequestContext;
    expect(getRateLimitKey(ctx)).toBe('ip:203.0.113.5');
  });

  it('falls back to a shared key when neither session nor IP is available', () => {
    expect(getRateLimitKey(undefined)).toBe('unknown');
    expect(getRateLimitKey({} as RequestContext)).toBe('unknown');
  });
});

describe('createPayment rate limiting', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn().mockImplementation(
      async () => new Response(JSON.stringify({ isValid: true, payer: '0xBuyer' }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    resetX402RateLimiters();
    configureX402RateLimit({ createPaymentMax: 2, windowMs: 60_000 });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetX402RateLimiters();
  });

  it('allows requests up to the configured limit', async () => {
    const ctx = ctxWithSession('buyer-a');
    const first = await x402PaymentMethodHandler.createPayment(ctx, order, 1000, configArgs(), { paymentPayload }, method);
    const second = await x402PaymentMethodHandler.createPayment(ctx, order, 1000, configArgs(), { paymentPayload }, method);

    expect(first.state).toBe('Authorized');
    expect(second.state).toBe('Authorized');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rejects an over-limit request locally, without reaching the facilitator', async () => {
    const ctx = ctxWithSession('buyer-b');
    await x402PaymentMethodHandler.createPayment(ctx, order, 1000, configArgs(), { paymentPayload }, method);
    await x402PaymentMethodHandler.createPayment(ctx, order, 1000, configArgs(), { paymentPayload }, method);
    fetchMock.mockClear();

    const result = await x402PaymentMethodHandler.createPayment(ctx, order, 1000, configArgs(), { paymentPayload }, method);

    expect(result.state).toBe('Declined');
    expect(result.errorMessage).toContain('Too many');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not let one session/IP exhaust another session/IP budget', async () => {
    const ctxA = ctxWithSession('buyer-c');
    const ctxB = ctxWithSession('buyer-d');
    await x402PaymentMethodHandler.createPayment(ctxA, order, 1000, configArgs(), { paymentPayload }, method);
    await x402PaymentMethodHandler.createPayment(ctxA, order, 1000, configArgs(), { paymentPayload }, method);

    const result = await x402PaymentMethodHandler.createPayment(ctxB, order, 1000, configArgs(), { paymentPayload }, method);

    expect(result.state).toBe('Authorized');
  });

  it('resets the limit once the window elapses', async () => {
    vi.useFakeTimers();
    try {
      const ctx = ctxWithSession('buyer-e');
      await x402PaymentMethodHandler.createPayment(ctx, order, 1000, configArgs(), { paymentPayload }, method);
      await x402PaymentMethodHandler.createPayment(ctx, order, 1000, configArgs(), { paymentPayload }, method);

      const overLimit = await x402PaymentMethodHandler.createPayment(ctx, order, 1000, configArgs(), { paymentPayload }, method);
      expect(overLimit.state).toBe('Declined');

      vi.advanceTimersByTime(60_001);

      const afterReset = await x402PaymentMethodHandler.createPayment(ctx, order, 1000, configArgs(), { paymentPayload }, method);
      expect(afterReset.state).toBe('Authorized');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('activeOrderX402PaymentRequirements rate limiting', () => {
  beforeEach(() => {
    resetX402RateLimiters();
    configureX402RateLimit({ requirementsMax: 2, windowMs: 60_000 });
  });

  afterEach(() => {
    resetX402RateLimiters();
  });

  function makeResolver() {
    const orderEntity = { currencyCode: 'USD', totalWithTax: 1099, id: 'order-1' } as Order;
    const activeOrderService = {
      getActiveOrder: vi.fn().mockResolvedValue(orderEntity),
    } as unknown as ActiveOrderService;
    const paymentMethodService = {
      getActivePaymentMethods: vi.fn().mockResolvedValue([
        { handler: { code: X402_PAYMENT_METHOD_CODE, args: configArgs() } } as unknown as PaymentMethod,
      ]),
    } as unknown as PaymentMethodService;
    const orderService = {
      findOne: vi.fn().mockResolvedValue({ ...orderEntity, payments: [] }),
    } as unknown as OrderService;
    return new X402Resolver(activeOrderService, paymentMethodService, orderService);
  }

  it('allows requests up to the configured limit', async () => {
    const resolver = makeResolver();
    const ctx = ctxWithSession('shopper-a');
    await expect(resolver.activeOrderX402PaymentRequirements(ctx)).resolves.toBeDefined();
    await expect(resolver.activeOrderX402PaymentRequirements(ctx)).resolves.toBeDefined();
  });

  it('rejects over-limit requests without touching order/payment-method services', async () => {
    const resolver = makeResolver();
    const ctx = ctxWithSession('shopper-b');
    await resolver.activeOrderX402PaymentRequirements(ctx);
    await resolver.activeOrderX402PaymentRequirements(ctx);

    await expect(resolver.activeOrderX402PaymentRequirements(ctx)).rejects.toThrow(/Too many requests/);
  });
});

describe('module-level singletons', () => {
  afterEach(() => resetX402RateLimiters());

  it('createPaymentRateLimiter and requirementsRateLimiter use the default limits until configured', () => {
    resetX402RateLimiters();
    for (let i = 0; i < DEFAULT_RATE_LIMIT.createPaymentMax; i++) {
      expect(createPaymentRateLimiter.consume('singleton-key')).toBe(true);
    }
    expect(createPaymentRateLimiter.consume('singleton-key')).toBe(false);

    for (let i = 0; i < DEFAULT_RATE_LIMIT.requirementsMax; i++) {
      expect(requirementsRateLimiter.consume('singleton-key-2')).toBe(true);
    }
    expect(requirementsRateLimiter.consume('singleton-key-2')).toBe(false);
  });
});
