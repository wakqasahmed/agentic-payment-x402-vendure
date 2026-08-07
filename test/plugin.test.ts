import { Subject } from 'rxjs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventBus, OrderService, Payment, PaymentStateTransitionEvent, TransactionalConnection } from '@vendure/core';

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
  let plugin: X402Plugin;
  let getEntityOrThrow: ReturnType<typeof vi.fn>;
  let settlePayment: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    events$ = new Subject<PaymentStateTransitionEvent>();
    eventBus = { ofType: vi.fn().mockReturnValue(events$) } as unknown as EventBus;
    getEntityOrThrow = vi.fn().mockResolvedValue({ state: 'Authorized' });
    settlePayment = vi.fn().mockResolvedValue({ state: 'Settled' });
    connection = { getEntityOrThrow } as unknown as TransactionalConnection;
    orderService = { settlePayment } as unknown as OrderService;
    plugin = new X402Plugin(eventBus, orderService, connection);
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

  it('logs but does not throw when the auto-settle attempt itself errors', async () => {
    const { Logger } = await import('@vendure/core');
    settlePayment.mockRejectedValueOnce(new Error('facilitator unreachable'));

    events$.next(makeEvent());
    await vi.waitFor(() => expect(settlePayment).toHaveBeenCalledTimes(1));
    await vi.waitFor(() => expect(Logger.error).toHaveBeenCalledTimes(1));
    expect((Logger.error as ReturnType<typeof vi.fn>).mock.calls[0][0]).toContain('facilitator unreachable');
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
