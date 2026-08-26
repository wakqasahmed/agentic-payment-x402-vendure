import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  EventBus,
  OrderService,
  Payment,
  PaymentMethodService,
  PaymentStateTransitionEvent,
  TransactionalConnection,
} from '@vendure/core';

import { X402_PAYMENT_METHOD_CODE } from '../src/constants.js';
import { X402Plugin } from '../src/plugin.js';

vi.mock('@vendure/core', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    Logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
  };
});

const ctx = { id: 'ctx' } as unknown as PaymentStateTransitionEvent['ctx'];

function makeEvent(overrides: Partial<{ method: string; toState: string; paymentId: string }> = {}): PaymentStateTransitionEvent {
  const paymentId = overrides.paymentId ?? 'payment-1';
  return {
    ctx,
    fromState: 'Created',
    toState: overrides.toState ?? 'Authorized',
    payment: { id: paymentId, method: overrides.method ?? X402_PAYMENT_METHOD_CODE } as Payment,
    order: {},
  } as unknown as PaymentStateTransitionEvent;
}

describe('X402Plugin auto-settle', () => {
  let events$: Subject<PaymentStateTransitionEvent>;
  let eventBus: EventBus;
  let orderService: OrderService;
  let connection: TransactionalConnection;
  let paymentMethodService: PaymentMethodService;
  let plugin: X402Plugin;
  let getEntityOrThrow: ReturnType<typeof vi.fn>;
  let settlePayment: ReturnType<typeof vi.fn>;
  let getMethodAndOperations: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    const { Logger } = await import('@vendure/core');
    (Logger.error as ReturnType<typeof vi.fn>).mockClear();
    events$ = new Subject<PaymentStateTransitionEvent>();
    eventBus = { ofType: vi.fn().mockReturnValue(events$) } as unknown as EventBus;
    getEntityOrThrow = vi.fn().mockResolvedValue({ state: 'Authorized' });
    settlePayment = vi.fn().mockResolvedValue({ state: 'Settled' });
    connection = { getEntityOrThrow } as unknown as TransactionalConnection;
    orderService = { settlePayment } as unknown as OrderService;
    // Default: the PaymentMethod's own code matches its handler's code, which
    // is the common case but must NOT be what the plugin relies on -- see the
    // "conflation" tests below, which deliberately break that assumption.
    getMethodAndOperations = vi.fn().mockImplementation(async (_ctx: unknown, method: string) => ({
      paymentMethod: { handler: { code: method } },
    }));
    paymentMethodService = { getMethodAndOperations } as unknown as PaymentMethodService;
    plugin = new X402Plugin(eventBus, orderService, connection, paymentMethodService);
    plugin.onApplicationBootstrap();
  });

  it('auto-settles as soon as a x402 Payment reaches Authorized', async () => {
    events$.next(makeEvent());
    await vi.waitFor(() => expect(settlePayment).toHaveBeenCalledTimes(1));
    expect(settlePayment).toHaveBeenCalledWith(ctx, 'payment-1');
  });

  it('ignores transitions for other payment methods', async () => {
    events$.next(makeEvent({ method: 'stripe' }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(settlePayment).not.toHaveBeenCalled();
  });

  it('ignores transitions to states other than Authorized', async () => {
    events$.next(makeEvent({ toState: 'Cancelled' }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(settlePayment).not.toHaveBeenCalled();
  });

  it('auto-settles a Payment whose PaymentMethod is coded differently than the x402 handler', async () => {
    // A merchant can name their PaymentMethod anything (e.g. "crypto-payments")
    // -- ownership must be determined by the handler code, not the method code.
    getMethodAndOperations.mockResolvedValueOnce({
      paymentMethod: { handler: { code: X402_PAYMENT_METHOD_CODE } },
    });

    events$.next(makeEvent({ method: 'crypto-payments' }));
    await vi.waitFor(() => expect(settlePayment).toHaveBeenCalledTimes(1));
    expect(getMethodAndOperations).toHaveBeenCalledWith(ctx, 'crypto-payments');
  });

  it('does not auto-settle a Payment on a method literally coded "x402" but backed by a different handler', async () => {
    getMethodAndOperations.mockResolvedValueOnce({
      paymentMethod: { handler: { code: 'some-other-handler' } },
    });

    events$.next(makeEvent({ method: X402_PAYMENT_METHOD_CODE }));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(settlePayment).not.toHaveBeenCalled();
  });

  it('does not throw when the PaymentMethod cannot be resolved', async () => {
    getMethodAndOperations.mockRejectedValueOnce(new Error('error.payment-method-not-found'));

    events$.next(makeEvent());
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(settlePayment).not.toHaveBeenCalled();
  });

  it('logs but does not throw when the auto-settle call itself throws (e.g. network timeout)', async () => {
    const { Logger } = await import('@vendure/core');
    settlePayment.mockRejectedValueOnce(new Error('facilitator unreachable'));

    events$.next(makeEvent());
    await vi.waitFor(() => expect(settlePayment).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(Logger.error).toHaveBeenCalledTimes(1));
    expect((Logger.error as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('facilitator unreachable');
  });

  it('logs when settlePayment resolves with a facilitator-rejected result instead of throwing', async () => {
    // The real facilitator-failure path: settlePayment resolves successfully
    // at the JS level with an ErrorResult-shaped object (or a Payment stuck
    // out of `Settled`), it does not reject/throw.
    const { Logger } = await import('@vendure/core');
    settlePayment.mockResolvedValueOnce({
      __typename: 'SettlePaymentError',
      errorCode: 'SETTLE_PAYMENT_ERROR',
      message: 'SETTLE_PAYMENT_ERROR',
      paymentErrorMessage: 'Facilitator rejected settlement: expired authorization',
    });

    events$.next(makeEvent());
    await vi.waitFor(() => expect(settlePayment).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(Logger.error).toHaveBeenCalledTimes(1));
    const loggedMessage = (Logger.error as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(loggedMessage).toContain('did not succeed');
    expect(loggedMessage).toContain('Facilitator rejected settlement: expired authorization');
  });

  it('logs when settlePayment resolves with a Payment left in a non-Settled state', async () => {
    const { Logger } = await import('@vendure/core');
    settlePayment.mockResolvedValueOnce({ state: 'Authorized' });

    events$.next(makeEvent());
    await vi.waitFor(() => expect(settlePayment).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(Logger.error).toHaveBeenCalledTimes(1));
    expect((Logger.error as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('Authorized');
  });

  it('does not double-broadcast when the transition event fires twice for the same payment', async () => {
    // First event still in flight (settlePayment not yet resolved) when the
    // second, duplicate event for the same payment arrives.
    let resolveFirst: (value: { state: string }) => void;
    settlePayment.mockReturnValueOnce(
      new Promise(resolve => {
        resolveFirst = resolve;
      }),
    );

    events$.next(makeEvent());
    events$.next(makeEvent());
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(settlePayment).toHaveBeenCalledTimes(1);

    resolveFirst!({ state: 'Settled' });
    await vi.waitFor(() => expect(getEntityOrThrow).toHaveBeenCalled());

    // A third event arrives after settlement already completed -- the fresh
    // state read shows it's no longer Authorized, so settlePayment must not
    // be invoked again.
    getEntityOrThrow.mockResolvedValueOnce({ state: 'Settled' });
    events$.next(makeEvent());
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(settlePayment).toHaveBeenCalledTimes(1);
  });
});
