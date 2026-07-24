/**
 * Converts a Vendure order amount (an integer in the order currency's minor
 * units, e.g. cents) into a stablecoin's atomic units (e.g. USDC has 6
 * decimals), assuming the asset is 1:1 pegged to `pegCurrencyCode`.
 *
 * Vendure doesn't expose a public per-currency decimal-places table to
 * plugins, so `pegCurrencyDecimals` is explicit configuration rather than
 * inferred — this handler is only correct when `order.currencyCode` matches
 * `pegCurrencyCode` exactly; callers must check that before invoking this.
 */
export function toAtomicUnits(
  minorUnitAmount: number,
  pegCurrencyDecimals: number,
  assetDecimals: number,
): string {
  if (!Number.isInteger(minorUnitAmount) || minorUnitAmount < 0) {
    throw new Error(`Expected a non-negative integer amount, got ${minorUnitAmount}`);
  }
  const scaleDiff = assetDecimals - pegCurrencyDecimals;
  const amount = BigInt(minorUnitAmount);
  if (scaleDiff >= 0) {
    return (amount * 10n ** BigInt(scaleDiff)).toString();
  }
  const divisor = 10n ** BigInt(-scaleDiff);
  if (amount % divisor !== 0n) {
    throw new Error(
      `Amount ${minorUnitAmount} (in ${pegCurrencyDecimals}-decimal minor units) can't be ` +
        `represented exactly in a ${assetDecimals}-decimal asset without loss of precision.`,
    );
  }
  return (amount / divisor).toString();
}
