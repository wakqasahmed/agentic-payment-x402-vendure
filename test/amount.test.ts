import { describe, expect, it } from 'vitest';

import { toAtomicUnits } from '../src/amount.js';

describe('toAtomicUnits', () => {
  it('converts USD cents to 6-decimal USDC atomic units', () => {
    expect(toAtomicUnits(1000, 2, 6)).toBe('10000000'); // $10.00 -> 10_000000
  });

  it('converts a zero amount', () => {
    expect(toAtomicUnits(0, 2, 6)).toBe('0');
  });

  it('handles an asset with fewer decimals than the peg currency', () => {
    expect(toAtomicUnits(1000, 2, 0)).toBe('10'); // $10.00 -> 10 whole units, exact
  });

  it('throws when the conversion would lose precision', () => {
    // $10.50 into a 0-decimal asset can't be represented exactly.
    expect(() => toAtomicUnits(1050, 2, 0)).toThrow(/precision/);
  });

  it('throws on a negative amount', () => {
    expect(() => toAtomicUnits(-100, 2, 6)).toThrow();
  });

  it('throws on a non-integer amount', () => {
    expect(() => toAtomicUnits(10.5, 2, 6)).toThrow();
  });
});
