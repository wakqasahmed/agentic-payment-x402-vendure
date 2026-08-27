import { describe, expect, it } from 'vitest';

import { checkKnownAssetForNetwork, isValidCaip2Network } from '../src/network.js';

describe('isValidCaip2Network', () => {
  it('accepts a well-formed CAIP-2 identifier', () => {
    expect(isValidCaip2Network('eip155:8453')).toBe(true);
  });

  it('rejects a bare chain name', () => {
    expect(isValidCaip2Network('base')).toBe(false);
  });
});

describe('checkKnownAssetForNetwork', () => {
  it('passes for the correct Base mainnet USDC address', () => {
    expect(checkKnownAssetForNetwork('eip155:8453', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')).toBeNull();
  });

  it('passes for the correct Base Sepolia USDC address', () => {
    expect(checkKnownAssetForNetwork('eip155:84532', '0x036CbD53842c5426634e7929541eC2318f3dCF7e')).toBeNull();
  });

  it('is case-insensitive on the address', () => {
    expect(
      checkKnownAssetForNetwork('eip155:8453', '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'),
    ).toBeNull();
  });

  it('flags a mismatched asset for a known network with a clear expected-vs-configured message', () => {
    const message = checkKnownAssetForNetwork('eip155:8453', '0x036CbD53842c5426634e7929541eC2318f3dCF7e');
    expect(message).not.toBeNull();
    expect(message).toContain('eip155:8453');
    expect(message).toContain('0x036CbD53842c5426634e7929541eC2318f3dCF7e');
    expect(message).toContain('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
  });

  it('flags a mainnet asset configured against the Sepolia network', () => {
    const message = checkKnownAssetForNetwork('eip155:84532', '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
    expect(message).not.toBeNull();
  });

  it('does not fail for a network outside the known-good lookup table', () => {
    expect(checkKnownAssetForNetwork('eip155:1', '0xAnythingAtAll')).toBeNull();
    expect(checkKnownAssetForNetwork('solana:mainnet', 'AnySplMintAddress')).toBeNull();
  });
});
