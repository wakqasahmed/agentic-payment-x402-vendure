/** Minimal shape of the x402 402-response payload for the currently active order. */
export interface X402PaymentRequirementsResult {
  x402Version: number;
  scheme: string;
  network: string;
  asset: string;
  amount: string;
  payTo: string;
  maxTimeoutSeconds: number;
}
