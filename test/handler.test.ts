import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfigArg } from '@vendure/common/lib/generated-types';
import { Logger } from '@vendure/core';
import type { Order, Payment, PaymentMethod, RequestContext } from '@vendure/core';

import { x402PaymentMethodHandler } from '../src/handler.js';
import { resetX402RateLimiters } from '../src/rate-limit.js';

const FACILITATOR_URL = 'https://facilitator.test';

function configArgs(overrides: Record<string, string> = {}): ConfigArg[] {
  const defaults: Record<string, string> = {
    facilitatorUrl: FACILITATOR_URL,
    payToAddress: '0xMerchant',
    network: 'eip155:8453',
    // Real Base mainnet USDC contract address, so the network/asset pairing
    // passes the known-asset check by default -- tests that specifically
    // exercise that check override network/asset explicitly.
    asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
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

/** Simulates an admin leaving an optional arg genuinely unset in the Admin UI
 * (not just empty) -- the ConfigArg entry is entirely absent from the stored
 * array, which is what `argsArrayToHash` actually receives. */
function configArgsOmitting(names: string[]): ConfigArg[] {
  return configArgs().filter(arg => !names.includes(arg.name));
}

const ctx = undefined as unknown as RequestContext;
const method = undefined as unknown as PaymentMethod;
const order = { currencyCode: 'USD', code: 'TEST-ORDER-1' } as Order;

// Matches the requirements built for a $10.00 (1000 cents) order under the
// default configArgs() above: toAtomicUnits(1000, 2, 6) -> "10000000".
const paymentPayload = {
  x402Version: 2,
  accepted: { scheme: 'exact', network: 'eip155:8453', asset: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', amount: '10000000', payTo: '0xMerchant', maxTimeoutSeconds: 300, extra: {} },
  payload: { signature: 'fake' },
} as unknown as Record<string, unknown>;

describe('x402PaymentMethodHandler.createPayment', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    // ctx is undefined in these tests, so every call shares the 'unknown'
    // rate-limit bucket -- reset between tests so unrelated tests don't
    // starve each other's budget.
    resetX402RateLimiters();
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
    // Authorized has no transaction hash yet -- only settlePayment produces
    // one. Setting transactionId to the payer address here would make every
    // order from the same wallet share a Payment.transactionId.
    expect(result.transactionId).toBeUndefined();
  });

  it('sanitizes a raw facilitator error (e.g. an HTML error page) before it reaches the buyer', async () => {
    fetchMock.mockResolvedValueOnce(new Response('<html>oops</html>', { status: 500 }));

    const result = await x402PaymentMethodHandler.createPayment(ctx, order, 1000, configArgs(), { paymentPayload }, method);
    expect(result.state).toBe('Declined');
    expect(result.errorMessage).not.toContain('<html>');
    expect(result.errorMessage).not.toContain('oops');
  });

  it('declines with a clear config error when network is not a valid CAIP-2 identifier', async () => {
    const result = await x402PaymentMethodHandler.createPayment(
      ctx,
      order,
      1000,
      configArgs({ network: 'base' }),
      { paymentPayload },
      method,
    );
    expect(result.state).toBe('Declined');
    expect(result.errorMessage).toContain('CAIP-2');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('declines with a clear config error when asset does not match the known USDC address for network', async () => {
    const result = await x402PaymentMethodHandler.createPayment(
      ctx,
      order,
      1000,
      // Base Sepolia testnet USDC paired with a Base mainnet network -- the
      // kind of misconfiguration this check exists to catch.
      configArgs({ network: 'eip155:8453', asset: '0x036CbD53842c5426634e7929541eC2318f3dCF7e' }),
      { paymentPayload },
      method,
    );
    expect(result.state).toBe('Declined');
    expect(result.errorMessage).toContain('eip155:8453');
    expect(result.errorMessage).toContain('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('does not decline for a correct known network/asset pairing', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ isValid: true, payer: '0xBuyer' }), { status: 200 }),
    );

    const asset = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
    const matchingPayload = {
      x402Version: 2,
      accepted: { scheme: 'exact', network: 'eip155:8453', asset, amount: '10000000', payTo: '0xMerchant', maxTimeoutSeconds: 300, extra: {} },
      payload: { signature: 'fake' },
    } as unknown as Record<string, unknown>;

    const result = await x402PaymentMethodHandler.createPayment(
      ctx,
      order,
      1000,
      configArgs({ network: 'eip155:8453', asset }),
      { paymentPayload: matchingPayload },
      method,
    );
    expect(result.state).toBe('Authorized');
  });

  it('does not decline for a network outside the known-good lookup table', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ isValid: true, payer: '0xBuyer' }), { status: 200 }),
    );

    const matchingPayload = {
      x402Version: 2,
      accepted: {
        scheme: 'exact',
        network: 'solana:mainnet',
        asset: 'AnySplMintAddress',
        amount: '10000000',
        payTo: '0xMerchant',
        maxTimeoutSeconds: 300,
        extra: {},
      },
      payload: { signature: 'fake' },
    } as unknown as Record<string, unknown>;

    const result = await x402PaymentMethodHandler.createPayment(
      ctx,
      order,
      1000,
      configArgs({ network: 'solana:mainnet', asset: 'AnySplMintAddress' }),
      { paymentPayload: matchingPayload },
      method,
    );
    expect(result.state).toBe('Authorized');
  });

  it('applies documented defaults for pegCurrencyDecimals/scheme/maxTimeoutSeconds when left unset', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ isValid: true, payer: '0xBuyer' }), { status: 200 }),
    );

    const result = await x402PaymentMethodHandler.createPayment(
      ctx,
      order,
      1000, // $10.00 in cents
      configArgsOmitting(['pegCurrencyDecimals', 'scheme', 'maxTimeoutSeconds']),
      { paymentPayload },
      method,
    );

    // Before the fix this computed 6 - undefined = NaN, and the buyer saw
    // "The number NaN cannot be converted to a BigInt because it is not an integer".
    expect(result.state).toBe('Authorized');
    const [, init] = fetchMock.mock.calls[0];
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.paymentRequirements.amount).toBe('10000000'); // defaulted pegCurrencyDecimals: 2
    expect(body.paymentRequirements.scheme).toBe('exact');
    expect(body.paymentRequirements.maxTimeoutSeconds).toBe(300);
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

  it('fails fast with a clear error when the facilitator hangs, instead of waiting forever', async () => {
    fetchMock.mockImplementation(() => new Promise(() => {})); // never resolves

    const result = await x402PaymentMethodHandler.createPayment(
      ctx,
      order,
      1000,
      configArgs({ facilitatorTimeoutSeconds: '0' }),
      { paymentPayload },
      method,
    );
    expect(result.state).toBe('Declined');
    expect(result.errorMessage).toContain('timed out');
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
    expect(result.errorMessage).toContain('No outstanding balance');
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
  let findOneMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    // The drift check (#39) now fails closed when orderService.findOne can't
    // return a fresh order, so every test in this describe block needs a
    // non-drifting mock order to genuinely exercise settlePayment's happy
    // path through the new guard, not just skip past it.
    findOneMock = vi.fn().mockResolvedValue({
      totalWithTax: 1000, // $10.00, matching every stored requirements.amount ('10000000') in this describe block
      payments: [],
    });
    const mockOrderService = { findOne: findOneMock };
    await x402PaymentMethodHandler.init({ get: () => mockOrderService } as unknown as Parameters<
      typeof x402PaymentMethodHandler.init
    >[0]);
    // ctx is undefined in these tests, so every call shares the 'unknown'
    // rate-limit bucket -- reset between tests so unrelated tests don't
    // starve each other's budget.
    resetX402RateLimiters();
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    // Reset the module-level orderService singleton so it can't leak into
    // later describe blocks that assume it's unset.
    await x402PaymentMethodHandler.init({ get: () => undefined } as unknown as Parameters<
      typeof x402PaymentMethodHandler.init
    >[0]);
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

  it('logs the tx hash the instant settlement succeeds, before returning to PaymentService', async () => {
    // PaymentService only persists payment.metadata/state *after* this
    // handler returns -- if that write fails, the tx hash needs to already
    // be somewhere durable (server logs), not just in the return value.
    const infoSpy = vi.spyOn(Logger, 'info').mockImplementation(() => undefined);

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ success: true, transaction: '0xDurableTx', network: 'eip155:8453' }),
        { status: 200 },
      ),
    );

    const payment = {
      id: 'payment-42',
      metadata: {
        paymentPayload,
        requirements: { scheme: 'exact', network: 'eip155:8453', asset: '0xUSDC', amount: '10000000', payTo: '0xMerchant', maxTimeoutSeconds: 300, extra: {} },
      },
    } as unknown as Payment;

    await x402PaymentMethodHandler.settlePayment(ctx, order, payment, configArgs(), method);

    expect(infoSpy).toHaveBeenCalledTimes(1);
    const [loggedMessage] = infoSpy.mock.calls[0];
    expect(loggedMessage).toContain('0xDurableTx');
    expect(loggedMessage).toContain('payment-42');
    infoSpy.mockRestore();
  });

  it('fails when createPayment metadata is missing', async () => {
    const payment = { metadata: {} } as unknown as Payment;
    const result = await x402PaymentMethodHandler.settlePayment(ctx, order, payment, configArgs(), method);
    expect(result.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails fast with a clear error when the facilitator hangs on settle', async () => {
    fetchMock.mockImplementation(() => new Promise(() => {})); // never resolves

    const payment = {
      metadata: {
        paymentPayload,
        requirements: { scheme: 'exact', network: 'eip155:8453', asset: '0xUSDC', amount: '10000000', payTo: '0xMerchant', maxTimeoutSeconds: 300, extra: {} },
      },
    } as unknown as Payment;

    const result = await x402PaymentMethodHandler.settlePayment(
      ctx,
      order,
      payment,
      configArgs({ facilitatorTimeoutSeconds: '0' }),
      method,
    );
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorMessage).toContain('timed out');
    }
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

  it('settles when the facilitator response amount/network match what was requested', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ success: true, transaction: '0xTx', network: 'eip155:8453', amount: '10000000' }),
        { status: 200 },
      ),
    );

    const payment = {
      id: 'payment-match',
      metadata: {
        paymentPayload,
        requirements: { scheme: 'exact', network: 'eip155:8453', asset: '0xUSDC', amount: '10000000', payTo: '0xMerchant', maxTimeoutSeconds: 300, extra: {} },
      },
    } as unknown as Payment;

    const result = await x402PaymentMethodHandler.settlePayment(ctx, order, payment, configArgs(), method);
    expect(result.success).toBe(true);
  });

  it('fails closed without settling when the facilitator response amount does not match the requested amount (exact scheme)', async () => {
    const errorSpy = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ success: true, transaction: '0xTx', network: 'eip155:8453', amount: '1' }),
        { status: 200 },
      ),
    );

    const payment = {
      id: 'payment-bad-amount',
      metadata: {
        paymentPayload,
        requirements: { scheme: 'exact', network: 'eip155:8453', asset: '0xUSDC', amount: '10000000', payTo: '0xMerchant', maxTimeoutSeconds: 300, extra: {} },
      },
    } as unknown as Payment;

    const result = await x402PaymentMethodHandler.settlePayment(ctx, order, payment, configArgs(), method);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorMessage).toContain('amount');
      // Funds already moved on-chain (facilitator returned success: true) --
      // the tx hash must still be recorded so it isn't lost, and so the
      // idempotency short-circuit / cancelPayment can find it on a retry.
      expect(result.metadata?.transaction).toBe('0xTx');
    }
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [loggedMessage] = errorSpy.mock.calls[0];
    expect(loggedMessage).toContain('amount mismatch');
    expect(loggedMessage).toContain('0xTx');
    errorSpy.mockRestore();
  });

  it('settles a legitimate partial payment under the upto scheme without treating it as a mismatch', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ success: true, transaction: '0xPartialTx', network: 'eip155:8453', amount: '7000000' }),
        { status: 200 },
      ),
    );

    const payment = {
      id: 'payment-upto-partial',
      metadata: {
        paymentPayload,
        requirements: { scheme: 'upto', network: 'eip155:8453', asset: '0xUSDC', amount: '10000000', payTo: '0xMerchant', maxTimeoutSeconds: 300, extra: {} },
      },
    } as unknown as Payment;

    const result = await x402PaymentMethodHandler.settlePayment(ctx, order, payment, configArgs({ scheme: 'upto' }), method);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.metadata?.transaction).toBe('0xPartialTx');
    }
  });

  it('fails closed when the upto scheme settlement amount exceeds the authorized maximum', async () => {
    const errorSpy = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ success: true, transaction: '0xOverTx', network: 'eip155:8453', amount: '11000000' }),
        { status: 200 },
      ),
    );

    const payment = {
      id: 'payment-upto-over',
      metadata: {
        paymentPayload,
        requirements: { scheme: 'upto', network: 'eip155:8453', asset: '0xUSDC', amount: '10000000', payTo: '0xMerchant', maxTimeoutSeconds: 300, extra: {} },
      },
    } as unknown as Payment;

    const result = await x402PaymentMethodHandler.settlePayment(ctx, order, payment, configArgs({ scheme: 'upto' }), method);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorMessage).toContain('amount');
      expect(result.metadata?.transaction).toBe('0xOverTx');
    }
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it('fails closed without settling when the facilitator response network does not match the requirements actually sent to /settle', async () => {
    const errorSpy = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);

    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ success: true, transaction: '0xTx', network: 'eip155:1', amount: '10000000' }),
        { status: 200 },
      ),
    );

    const payment = {
      id: 'payment-bad-network',
      metadata: {
        paymentPayload,
        requirements: { scheme: 'exact', network: 'eip155:8453', asset: '0xUSDC', amount: '10000000', payTo: '0xMerchant', maxTimeoutSeconds: 300, extra: {} },
      },
    } as unknown as Payment;

    const result = await x402PaymentMethodHandler.settlePayment(ctx, order, payment, configArgs(), method);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorMessage).toContain('network');
      expect(result.metadata?.transaction).toBe('0xTx');
    }
    expect(errorSpy).toHaveBeenCalledTimes(1);
    const [loggedMessage] = errorSpy.mock.calls[0];
    expect(loggedMessage).toContain('network mismatch');
    expect(loggedMessage).toContain('0xTx');
    errorSpy.mockRestore();
  });

  it('does not false-positive on network when live config has changed since authorize time, as long as the facilitator response matches the frozen requirements', async () => {
    // stored.requirements.network was frozen from args.network at authorize
    // time. If an admin edits the payment method's network config before
    // settlePayment runs, args.network here is stale/different -- the
    // facilitator was still sent (and correctly echoes) stored.requirements.network,
    // which must be treated as a match, not a mismatch.
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ success: true, transaction: '0xTx', network: 'eip155:8453', amount: '10000000' }),
        { status: 200 },
      ),
    );

    const payment = {
      id: 'payment-config-drift',
      metadata: {
        paymentPayload,
        requirements: { scheme: 'exact', network: 'eip155:8453', asset: '0xUSDC', amount: '10000000', payTo: '0xMerchant', maxTimeoutSeconds: 300, extra: {} },
      },
    } as unknown as Payment;

    // args.network now points at a different chain than what was frozen in
    // stored.requirements.network at authorize time.
    const result = await x402PaymentMethodHandler.settlePayment(ctx, order, payment, configArgs({ network: 'eip155:1' }), method);
    expect(result.success).toBe(true);
  });
});

describe('x402PaymentMethodHandler.settlePayment order total drift check (#39)', () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let findOneMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    findOneMock = vi.fn();
    const mockOrderService = { findOne: findOneMock };
    await x402PaymentMethodHandler.init({ get: () => mockOrderService } as unknown as Parameters<
      typeof x402PaymentMethodHandler.init
    >[0]);
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await x402PaymentMethodHandler.init({ get: () => undefined } as unknown as Parameters<
      typeof x402PaymentMethodHandler.init
    >[0]);
  });

  function makePayment(id: string) {
    return {
      id,
      metadata: {
        paymentPayload,
        requirements: {
          scheme: 'exact',
          network: 'eip155:8453',
          asset: '0xUSDC',
          amount: '10000000', // frozen at authorize time for a $10.00 order
          payTo: '0xMerchant',
          maxTimeoutSeconds: 300,
          extra: {},
        },
      },
    } as unknown as Payment;
  }

  it('settles normally when the order total is unchanged since authorize', async () => {
    findOneMock.mockResolvedValueOnce({
      totalWithTax: 1000, // still $10.00
      payments: [{ id: 'payment-unchanged', state: 'Authorized', amount: 1000, refunds: [] }],
    });
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, transaction: '0xTx', network: 'eip155:8453' }), { status: 200 }),
    );

    const payment = makePayment('payment-unchanged');
    const result = await x402PaymentMethodHandler.settlePayment(ctx, order, payment, configArgs(), method);

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('fails closed without calling the facilitator when the order total changed since authorize', async () => {
    const errorSpy = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);

    findOneMock.mockResolvedValueOnce({
      totalWithTax: 2000, // admin edit bumped the order to $20.00
      payments: [{ id: 'payment-changed', state: 'Authorized', amount: 1000, refunds: [] }],
    });

    const payment = makePayment('payment-changed');
    const result = await x402PaymentMethodHandler.settlePayment(ctx, order, payment, configArgs(), method);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorMessage).toContain('Order total changed');
    }
    expect(fetchMock).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('excludes the payment being settled itself from the outstanding-balance recomputation', async () => {
    // The Payment being settled is already Authorized and present in
    // freshOrder.payments -- if it weren't excluded, its own amount would be
    // double-counted against the outstanding balance it's supposed to cover,
    // producing a false-positive drift failure on every settle.
    findOneMock.mockResolvedValueOnce({
      totalWithTax: 1000,
      payments: [{ id: 'payment-self', state: 'Authorized', amount: 1000, refunds: [] }],
    });
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, transaction: '0xTx', network: 'eip155:8453' }), { status: 200 }),
    );

    const payment = makePayment('payment-self');
    const result = await x402PaymentMethodHandler.settlePayment(ctx, order, payment, configArgs(), method);

    expect(result.success).toBe(true);
  });

  it('excludes only the settling payment when a distinct sibling payment also covers part of the order', async () => {
    // Two Authorized payments on the order: the one being settled ($10, id
    // 'payment-self') and a different, unrelated payment ($10, id
    // 'payment-sibling'). The sibling must stay in the outstanding-balance
    // computation (proving the id filter excludes only the settling payment,
    // not every payment) while payment-self must be excluded (proving it
    // isn't double-counted against its own requirement).
    findOneMock.mockResolvedValueOnce({
      totalWithTax: 2000, // $20.00 order covered by both payments together
      payments: [
        { id: 'payment-self', state: 'Authorized', amount: 1000, refunds: [] },
        { id: 'payment-sibling', state: 'Authorized', amount: 1000, refunds: [] },
      ],
    });
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ success: true, transaction: '0xTx', network: 'eip155:8453' }), { status: 200 }),
    );

    // outstanding = 2000 (totalWithTax) - 1000 (sibling, correctly not excluded) = 1000
    // -> converts to the frozen 10000000 -> settles.
    const payment = makePayment('payment-self');
    const result = await x402PaymentMethodHandler.settlePayment(ctx, order, payment, configArgs(), method);

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('detects drift caused by a sibling payment changing the order-total coverage, not just totalWithTax', async () => {
    const errorSpy = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);

    findOneMock.mockResolvedValueOnce({
      totalWithTax: 2000,
      payments: [
        { id: 'payment-self', state: 'Authorized', amount: 1000, refunds: [] },
        // Sibling now covers more than it did at authorize time (e.g. an
        // admin bumped it), shrinking payment-self's true outstanding share.
        { id: 'payment-sibling', state: 'Authorized', amount: 1500, refunds: [] },
      ],
    });

    // outstanding = 2000 - 1500 = 500 -> converts to 5000000, which no longer
    // matches the frozen 10000000 -> fails closed, facilitator never called.
    const payment = makePayment('payment-self');
    const result = await x402PaymentMethodHandler.settlePayment(ctx, order, payment, configArgs(), method);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorMessage).toContain('Order total changed');
    }
    expect(fetchMock).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('fails closed without settling when the order cannot be re-fetched at all', async () => {
    // orderService.findOne returning undefined is reachable in production
    // (e.g. a RequestContext on a different channel than the order's), not
    // just "orderService is unset" -- not being able to verify the order
    // total must fail closed the same way a detected drift does.
    const errorSpy = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
    findOneMock.mockResolvedValueOnce(undefined);

    const payment = makePayment('payment-unreachable');
    const result = await x402PaymentMethodHandler.settlePayment(ctx, order, payment, configArgs(), method);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorMessage).toContain('re-validate');
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
  });

  it('fails closed without settling when orderService was never injected (init() not run)', async () => {
    // Same fail-closed path as findOne returning undefined -- "can't verify"
    // covers DI-not-ready and channel-mismatch/order-not-found with one code
    // path, so this must behave identically without a dedicated branch.
    const errorSpy = vi.spyOn(Logger, 'error').mockImplementation(() => undefined);
    await x402PaymentMethodHandler.init({ get: () => undefined } as unknown as Parameters<
      typeof x402PaymentMethodHandler.init
    >[0]);

    const payment = makePayment('payment-no-di');
    const result = await x402PaymentMethodHandler.settlePayment(ctx, order, payment, configArgs(), method);

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.errorMessage).toContain('re-validate');
    }
    expect(fetchMock).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledTimes(1);
    errorSpy.mockRestore();
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
