import type { PaymentPayload, PaymentRequirements } from '@x402/core/types';

/**
 * `metadata.paymentPayload` is the raw JSON scalar from `addPaymentToOrder` --
 * any active session can put an arbitrarily large or malformed blob there, and
 * it would otherwise be forwarded to an external facilitator on every call.
 * Cap it well above what a real signed x402 payload needs.
 */
export const MAX_PAYMENT_PAYLOAD_BYTES = 16 * 1024;

/**
 * Validates the client-supplied `paymentPayload` has the minimally expected
 * shape and actually matches the server-built `requirements` before it's
 * forwarded to the facilitator. This plugin's amount-correctness guarantee
 * ultimately still depends on the configured facilitator enforcing exact-match
 * verification for the `exact` scheme -- this check exists so a malformed or
 * mismatched payload never reaches the facilitator at all, not to replace it.
 *
 * Returns an error message if the payload is invalid, or `null` if it's OK
 * to forward.
 */
export function validatePaymentPayload(
  raw: unknown,
  requirements: Pick<PaymentRequirements, 'scheme' | 'network' | 'asset' | 'amount' | 'payTo'>,
): string | null {
  if (JSON.stringify(raw).length > MAX_PAYMENT_PAYLOAD_BYTES) {
    return `Payment payload exceeds the maximum allowed size of ${MAX_PAYMENT_PAYLOAD_BYTES} bytes.`;
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return 'Payment payload must be an object.';
  }
  const payload = raw as Partial<PaymentPayload>;

  if (typeof payload.x402Version !== 'number') {
    return 'Payment payload is missing a numeric "x402Version".';
  }
  if (typeof payload.payload !== 'object' || payload.payload === null || Array.isArray(payload.payload)) {
    return 'Payment payload is missing a "payload" object (the scheme-specific signed data).';
  }
  if (
    typeof payload.accepted !== 'object' ||
    payload.accepted === null ||
    Array.isArray(payload.accepted)
  ) {
    return 'Payment payload is missing an "accepted" object.';
  }

  const accepted = payload.accepted as Partial<PaymentRequirements>;
  if (accepted.scheme !== requirements.scheme) {
    return `Payment payload scheme "${String(accepted.scheme)}" does not match the required scheme "${requirements.scheme}".`;
  }
  if (accepted.network !== requirements.network) {
    return `Payment payload network "${String(accepted.network)}" does not match the required network "${requirements.network}".`;
  }
  if (accepted.asset !== requirements.asset) {
    return `Payment payload asset "${String(accepted.asset)}" does not match the required asset "${requirements.asset}".`;
  }
  if (accepted.payTo !== requirements.payTo) {
    return `Payment payload payTo "${String(accepted.payTo)}" does not match the required payTo "${requirements.payTo}".`;
  }
  if (accepted.amount !== requirements.amount) {
    return `Payment payload amount "${String(accepted.amount)}" does not match the required amount "${requirements.amount}".`;
  }

  return null;
}
