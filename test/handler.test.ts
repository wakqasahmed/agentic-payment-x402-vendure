import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigArg } from '@vendure/common/lib/generated-types';
import type { Order, Payment, PaymentMethod, RequestContext } from '@vendure/core';

import { x402PaymentMethodHandler } from '../src/handler.js';

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
    ...overrides,
  };
  return Object.entries(defaults).map(([name, value]) => ({ name, value }));
}

const ctx = undefined as unknown as RequestContext;
const method = undefined as unknown as PaymentMethod;
const order = { currencyCode: 'USD' } as Order;

// Matches the requirements built for a $10.00 (1000 cents) order under the
// default configArgs() above: toAtomicUnits(1000, 2, 6) -> "10000000".
const paymentPayload = {
  x402Version: 2,
  accepted: { scheme: 'exact', network: 'eip155:8453', asset: '0xUSDC', amount: '10000000', payTo: '0xMerchant', maxTimeoutSeconds: 300, extra: {} },
  payload: { signature: 'fake' },
} as unknown as Record<string, unknown>;

describe('x402PaymentMethodHandler.createPayment', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('declines when the order currency does not match the configured peg currency', async () => {
    const result = await x402PaymentMethodHandler.createPayment(
      ctx,
      { currencyCode: 'EUR' } as Order,
      1000,
      configArgs(),
      { paymentPayload },
      method,
    );
    expect(result.state).toBe('Declined');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('declines when no payment payload was submitted', async () => {
    const result = await x402PaymentMethodHandler.createPayment(ctx, order, 1000, configArgs(), {}, method);
    expect(result.state).toBe('Declined');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('verifies the payment and converts the amount to atomic units', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ isValid: true, payer: '0xBuyer' }), { status: 200 }),
    );

    const result = await x402PaymentMethodHandler.createPayment(
      ctx,
      order,
      1000, // $10.00 in cents
      configArgs(),
      { paymentPayload },
      method,
    );

    expect(result.state).toBe('Authorized');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`${FACILITATOR_URL}/verify`);
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.paymentRequirements.amount).toBe('10000000'); // 6-decimal USDC
    // EIP-3009 signing/verification needs the asset's own EIP-712 domain --
    // without it the facilitator can't reconstruct the signed typed-data hash.
    expect(body.paymentRequirements.extra).toEqual({ name: 'USDC', version: '2' });
  });

  it('declines with an actionable error when assetName/assetVersion are not configured', async () => {
    const result = await x402PaymentMethodHandler.createPayment(
      ctx,
      order,
      1000,
      configArgs({ assetName: '', assetVersion: '' }),
      { paymentPayload },
      method,
    );
    expect(result.state).toBe('Declined');
    expect(result.errorMessage).toContain('assetName');
    expect(result.errorMessage).toContain('assetVersion');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('declines when the facilitator reports the payment as invalid', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ isValid: false, invalidReason: 'insufficient_funds' }),
        { status: 200 },
      ),
    );

    const result = await x402PaymentMethodHandler.createPayment(
      ctx,
      order,
      1000,
      configArgs(),
      { paymentPayload },
      method,
    );
    expect(result.state).toBe('Declined');
    expect(result.errorMessage).toContain('insufficient_funds');
  });

  it('declines a zero-amount payment without calling the facilitator (fully-discounted order)', async () => {
    const result = await x402PaymentMethodHandler.createPayment(ctx, order, 0, configArgs(), { paymentPayload }, method);
    expect(result.state).toBe('Declined');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('declines a zero-amount payment for the ArrangingAdditionalPayment zero-remaining-balance case', async () => {
    // Vendure computes `amount` as `amountToPay = totalWithTax - totalCoveredByPayments`
    // before calling this handler, so a fully-covered order reaches createPayment with
    // amount 0 exactly the same way a $0 order total would -- same guard, same test.
    const result = await x402PaymentMethodHandler.createPayment(ctx, order, 0, configArgs(), { paymentPayload }, method);
    expect(result.state).toBe('Declined');
    expect(result.errorMessage).toContain('Nothing to charge');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a payload whose signed amount does not match the order total, without calling the facilitator', async () => {
    // Signed for $1 (1000000 atomic units) against a $10.00 (1000-cent) order.
    // Previously this reached the facilitator and was authorized purely on
    // trust that the facilitator would catch the mismatch server-side.
    const mismatchedPayload = {
      ...paymentPayload,
      accepted: { ...(paymentPayload as { accepted: Record<string, unknown> }).accepted, amount: '1000000' },
    };

    const result = await x402PaymentMethodHandler.createPayment(
      ctx,
      order,
      1000,
      configArgs(),
      { paymentPayload: mismatchedPayload },
      method,
    );
    expect(result.state).toBe('Declined');
    expect(result.errorMessage).toContain('amount');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a malformed payload (not an object) before calling the facilitator', async () => {
    const result = await x402PaymentMethodHandler.createPayment(
      ctx,
      order,
      1000,
      configArgs(),
      { paymentPayload: 'not-an-object' },
      method,
    );
    expect(result.state).toBe('Declined');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a payload missing required fields before calling the facilitator', async () => {
    const result = await x402PaymentMethodHandler.createPayment(
      ctx,
      order,
      1000,
      configArgs(),
      { paymentPayload: { x402Version: 2 } },
      method,
    );
    expect(result.state).toBe('Declined');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects an oversized payload before calling the facilitator', async () => {
    const oversizedPayload = {
      ...paymentPayload,
      payload: { signature: 'x'.repeat(20 * 1024) },
    };

    const result = await x402PaymentMethodHandler.createPayment(
      ctx,
      order,
      1000,
      configArgs(),
      { paymentPayload: oversizedPayload },
      method,
    );
    expect(result.state).toBe('Declined');
    expect(result.errorMessage).toContain('size');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('x402PaymentMethodHandler.settlePayment', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('settles using the payload/requirements stored from createPayment', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ success: true, transaction: '0xTx', network: 'eip155:8453' }),
        { status: 200 },
      ),
    );

    const payment = {
      metadata: {
        paymentPayload,
        requirements: {
          scheme: 'exact',
          network: 'eip155:8453',
          asset: '0xUSDC',
          amount: '10000000',
          payTo: '0xMerchant',
          maxTimeoutSeconds: 300,
          extra: {},
        },
      },
    } as unknown as Payment;

    const result = await x402PaymentMethodHandler.settlePayment(ctx, order, payment, configArgs(), method);
    expect(result.success).toBe(true);
    const [url] = fetchMock.mock.calls[0];
    expect(url).toBe(`${FACILITATOR_URL}/settle`);
  });

  it('fails when createPayment metadata is missing', async () => {
    const payment = { metadata: {} } as unknown as Payment;
    const result = await x402PaymentMethodHandler.settlePayment(ctx, order, payment, configArgs(), method);
    expect(result.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('is idempotent: a payment already carrying a settlement transaction short-circuits without re-calling the facilitator', async () => {
    const payment = {
      metadata: {
        paymentPayload,
        requirements: { scheme: 'exact', network: 'eip155:8453', asset: '0xUSDC', amount: '10000000', payTo: '0xMerchant', maxTimeoutSeconds: 300, extra: {} },
        transaction: '0xAlreadySettled',
      },
    } as unknown as Payment;

    const result = await x402PaymentMethodHandler.settlePayment(ctx, order, payment, configArgs(), method);
    expect(result.success).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
    // Sourced from the configured args, not read back off stored metadata.
    if (result.success) {
      expect(result.metadata?.network).toBe('eip155:8453');
    }
  });
});

describe('x402PaymentMethodHandler.cancelPayment', () => {
  it('is a no-op success when still Authorized (no funds moved before settlement)', async () => {
    const payment = { state: 'Authorized', metadata: {} } as unknown as Payment;
    const result = await x402PaymentMethodHandler.cancelPayment(ctx, order, payment, configArgs(), method);
    expect(result?.success).toBe(true);
  });

  it('rejects cancelling a Settled payment (irreversible on-chain transfer, no refund path)', async () => {
    const payment = { state: 'Settled', metadata: { transaction: '0xabc' } } as unknown as Payment;
    const result = await x402PaymentMethodHandler.cancelPayment(ctx, order, payment, configArgs(), method);
    expect(result?.success).toBe(false);
  });

  it('rejects cancelling when a settlement transaction is recorded even if state lags', async () => {
    const payment = { state: 'Authorized', metadata: { transaction: '0xabc' } } as unknown as Payment;
    const result = await x402PaymentMethodHandler.cancelPayment(ctx, order, payment, configArgs(), method);
    expect(result?.success).toBe(false);
  });
});
