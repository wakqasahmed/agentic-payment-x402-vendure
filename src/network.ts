/**
 * `PaymentRequirements['network']` is typed as a CAIP-2 identifier
 * (`${string}:${string}`), but Vendure's `network` config arg is a plain
 * string an admin types into the Admin UI. There's no config-save-time
 * validation hook on `PaymentMethodHandler` args, so a typo like "base"
 * instead of "eip155:8453" compiles fine and only fails at buyer-checkout
 * time. Check the shape explicitly wherever the value is used instead.
 */
export function isValidCaip2Network(value: string): boolean {
  const parts = value.split(':');
  return parts.length === 2 && parts[0].length > 0 && parts[1].length > 0;
}

/**
 * Known-good USDC contract addresses per CAIP-2 network, used to catch a
 * misconfigured `asset` (e.g. a testnet address paired with a mainnet
 * `network`, or vice versa) that would otherwise compile fine and only fail
 * confusingly at the facilitator. Only networks this package has verified
 * data for are listed here -- a network that isn't a key below is outside
 * this table's scope and must not be treated as a mismatch.
 *
 * Sourced from Circle's official USDC contract address list
 * (https://developers.circle.com/stablecoins/usdc-contract-addresses),
 * cross-checked against BaseScan/Blockscout.
 */
export const KNOWN_USDC_ADDRESSES_BY_NETWORK: Readonly<Record<string, string>> = {
  'eip155:8453': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913', // Base mainnet
  'eip155:84532': '0x036CbD53842c5426634e7929541eC2318f3dCF7e', // Base Sepolia
};

/**
 * Checks a configured `asset` address against this package's known-good
 * lookup table for `network`. Returns `null` when the pair is fine to use --
 * either because it matches, or because `network` isn't one this package has
 * verified data for (e.g. a chain/asset this plugin supports beyond the
 * table). Returns a human-readable mismatch message otherwise.
 */
export function checkKnownAssetForNetwork(network: string, asset: string): string | null {
  const expected = KNOWN_USDC_ADDRESSES_BY_NETWORK[network];
  if (!expected) {
    return null;
  }
  if (expected.toLowerCase() !== asset.toLowerCase()) {
    return (
      `x402 payment method is misconfigured: asset "${asset}" does not match the known USDC ` +
      `contract address for network "${network}" (expected "${expected}"). Reconfigure this ` +
      'payment method in the Admin UI, or confirm the network/asset pairing is intentional.'
    );
  }
  return null;
}
