import { describe, expect, it } from 'vitest';

import { MAX_PAYMENT_PAYLOAD_BYTES, validatePaymentPayload } from '../src/payment-payload.js';

const requirements = {
  scheme: 'exact',
  network: 'eip155:8453',
  asset: '0xUSDC',
  amount: '10000000',
  payTo: '0xMerchant',
} as const;

const validPayload = {
  x402Version: 2,
  accepted: { scheme: 'exact', network: 'eip155:8453', asset: '0xUSDC', amount: '10000000', payTo: '0xMerchant', maxTimeoutSeconds: 300, extra: {} },
  payload: { signature: 'fake' },
};

describe('validatePaymentPayload', () => {
  it('accepts a well-formed payload matching the requirements', () => {
    expect(validatePaymentPayload(validPayload, requirements)).toBeNull();
  });

  it.each([
    ['a string', 'not-an-object'],
    ['a number', 42],
    ['an array', []],
    ['null', null],
  ])('rejects %s payload', (_label, raw) => {
    expect(validatePaymentPayload(raw, requirements)).toMatch(/object/i);
  });

  it('rejects a missing x402Version', () => {
    const withoutVersion: Record<string, unknown> = { ...validPayload };
    delete withoutVersion.x402Version;
    expect(validatePaymentPayload(withoutVersion, requirements)).toMatch(/x402Version/);
  });

  it('rejects a missing payload object', () => {
    const withoutPayload: Record<string, unknown> = { ...validPayload };
    delete withoutPayload.payload;
    expect(validatePaymentPayload(withoutPayload, requirements)).toMatch(/payload/i);
  });

  it('rejects a missing accepted object', () => {
    const withoutAccepted: Record<string, unknown> = { ...validPayload };
    delete withoutAccepted.accepted;
    expect(validatePaymentPayload(withoutAccepted, requirements)).toMatch(/accepted/i);
  });

  it.each(['scheme', 'network', 'asset', 'payTo', 'amount'] as const)(
    'rejects a mismatched %s',
    field => {
      const mismatched = { ...validPayload, accepted: { ...validPayload.accepted, [field]: 'wrong-value' } };
      expect(validatePaymentPayload(mismatched, requirements)).toMatch(new RegExp(field, 'i'));
    },
  );

  it('rejects a payload larger than the size cap', () => {
    const oversized = { ...validPayload, payload: { signature: 'x'.repeat(MAX_PAYMENT_PAYLOAD_BYTES) } };
    expect(validatePaymentPayload(oversized, requirements)).toMatch(/size/i);
  });
});
