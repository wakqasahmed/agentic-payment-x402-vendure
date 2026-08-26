/** Minimal shape of the x402 402-response payload for the currently active order. */
export interface X402PaymentRequirementsResult {
  x402Version: number;
  scheme: string;
  network: string;
  asset: string;
  /** The asset contract's EIP-712 domain, mirroring the `extra` shape sent to the facilitator. */
  extra: { name: string; version: string };
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
}
