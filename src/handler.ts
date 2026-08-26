import { LanguageCode, PaymentMethodHandler } from '@vendure/core';
import type {
  CancelPaymentErrorResult,
  CancelPaymentResult,
  CreatePaymentErrorResult,
  CreatePaymentResult,
  SettlePaymentErrorResult,
  SettlePaymentResult,
} from '@vendure/core';
import { HTTPFacilitatorClient } from '@x402/core/http';
import {
  VerifyError,
  SettleError,
  type PaymentPayload,
  type PaymentRequirements,
} from '@x402/core/types';

import { toAtomicUnits } from './amount.js';
import { X402_PAYMENT_METHOD_CODE } from './constants.js';
import { validatePaymentPayload } from './payment-payload.js';

/**
 * The x402 `PaymentPayload` the buyer's agent/wallet produced when it signed
 * the payment, passed through `addPaymentToOrder`'s `metadata` argument.
 * There's no server-issued "client secret" here (unlike Stripe): the client
 * must first fetch requirements via the `activeOrderX402PaymentRequirements`
 * query this plugin adds to the Shop API, sign a matching payment, then
 * submit it as `metadata.paymentPayload`. Validated by `validatePaymentPayload`
 * against the server-built requirements before it's ever forwarded anywhere.
 */

class FacilitatorTimeoutError extends Error {}

/**
 * `HTTPFacilitatorClient.verify`/`settle` call `fetch` internally with no
 * `AbortSignal`, and Node's `fetch` has no default timeout -- a black-holed
 * or slow facilitator would otherwise hang `createPayment`/`settlePayment`
 * indefinitely. This can't cancel the underlying request (no way to pass an
 * AbortSignal through), but it does stop the handler from hanging so the
 * caller gets a clear, fast failure instead of an indefinite wait.
 */
function withTimeout<T>(promise: Promise<T>, timeoutSeconds: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new FacilitatorTimeoutError(`Facilitator ${label} timed out after ${timeoutSeconds}s.`));
    }, timeoutSeconds * 1000);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      err => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * The x402 payment method for Vendure. Maps x402's verify/settle split onto
 * Vendure's Authorized -> Settled two-step payment flow: `createPayment`
 * verifies the signed payment is well-formed (no funds move yet, matching
 * x402's trust-minimizing design), `settlePayment` broadcasts it.
 *
 * `createRefund` is intentionally omitted -- x402 exact-scheme settlements
 * are on-chain transfers with no facilitator-side reversal primitive, and
 * this plugin never holds merchant keys to issue one itself. Per Vendure's
 * own PaymentMethodHandler docs, omitting it means refunds are settled
 * manually by an administrator, which is the correct behavior here, not a
 * missing feature.
 */
export const x402PaymentMethodHandler = new PaymentMethodHandler({
  code: X402_PAYMENT_METHOD_CODE,
  description: [{ languageCode: LanguageCode.en, value: 'Pay with x402 (stablecoin)' }],
  args: {
    facilitatorUrl: {
      type: 'string',
      required: false,
      label: [{ languageCode: LanguageCode.en, value: 'Facilitator URL' }],
      description: [
        {
          languageCode: LanguageCode.en,
          value: 'x402 facilitator base URL. Defaults to the public x402.org facilitator (testnet-only).',
        },
      ],
    },
    payToAddress: {
      type: 'string',
      label: [{ languageCode: LanguageCode.en, value: 'Pay-to address' }],
      description: [
        { languageCode: LanguageCode.en, value: "The merchant's receiving wallet address." },
      ],
    },
    network: {
      type: 'string',
      label: [{ languageCode: LanguageCode.en, value: 'Network' }],
      description: [
        { languageCode: LanguageCode.en, value: 'CAIP-2 network identifier, e.g. "eip155:8453" for Base.' },
      ],
    },
    asset: {
      type: 'string',
      label: [{ languageCode: LanguageCode.en, value: 'Asset' }],
      description: [
        { languageCode: LanguageCode.en, value: 'The stablecoin contract/mint address to accept payment in.' },
      ],
    },
    assetDecimals: {
      type: 'int',
      label: [{ languageCode: LanguageCode.en, value: 'Asset decimals' }],
      description: [{ languageCode: LanguageCode.en, value: 'Decimal places of the asset, e.g. 6 for USDC.' }],
    },
    assetName: {
      type: 'string',
      label: [{ languageCode: LanguageCode.en, value: 'Asset EIP-712 name' }],
      description: [
        {
          languageCode: LanguageCode.en,
          value:
            "The asset contract's EIP-712 domain `name` (e.g. \"USDC\"). Required for the exact-EVM " +
            'scheme to sign and verify the EIP-3009 `transferWithAuthorization` typed data.',
        },
      ],
    },
    assetVersion: {
      type: 'string',
      label: [{ languageCode: LanguageCode.en, value: 'Asset EIP-712 version' }],
      description: [
        {
          languageCode: LanguageCode.en,
          value: "The asset contract's EIP-712 domain `version` (e.g. \"2\" for USDC).",
        },
      ],
    },
    pegCurrencyCode: {
      type: 'string',
      label: [{ languageCode: LanguageCode.en, value: 'Peg currency code' }],
      description: [
        {
          languageCode: LanguageCode.en,
          value:
            'The ISO 4217 currency this asset is assumed 1:1 pegged to (e.g. "USD" for USDC). ' +
            'Orders in any other currency are rejected by this payment method.',
        },
      ],
    },
    pegCurrencyDecimals: {
      type: 'int',
      required: false,
      defaultValue: 2,
      label: [{ languageCode: LanguageCode.en, value: 'Peg currency decimals' }],
      description: [
        { languageCode: LanguageCode.en, value: 'Decimal places of pegCurrencyCode as Vendure stores it (2 for USD).' },
      ],
    },
    scheme: {
      type: 'string',
      required: false,
      defaultValue: 'exact',
      label: [{ languageCode: LanguageCode.en, value: 'Scheme' }],
    },
    maxTimeoutSeconds: {
      type: 'int',
      required: false,
      defaultValue: 300,
      label: [{ languageCode: LanguageCode.en, value: 'Max timeout (seconds)' }],
    },
    facilitatorTimeoutSeconds: {
      type: 'int',
      required: false,
      defaultValue: 30,
      label: [{ languageCode: LanguageCode.en, value: 'Facilitator HTTP timeout (seconds)' }],
      description: [
        {
          languageCode: LanguageCode.en,
          value: 'How long to wait for the facilitator to respond to verify/settle before failing fast.',
        },
      ],
    },
  },
  createPayment: async (_ctx, order, amount, args, metadata): Promise<CreatePaymentResult | CreatePaymentErrorResult> => {
    if (order.currencyCode !== args.pegCurrencyCode) {
      return {
        amount,
        state: 'Declined' as const,
        errorMessage:
          `Order currency ${order.currencyCode} does not match this payment method's ` +
          `configured peg currency ${args.pegCurrencyCode}.`,
      };
    }

    if (amount <= 0) {
      // Zero: a fully-discounted order, or the remaining balance on a
      // partially-paid order -- a facilitator that only checks
      // signedValue >= requiredAmount would treat almost any payload as
      // satisfying a $0 requirement, so don't round-trip to it at all.
      // Negative shouldn't be reachable in practice (Vendure computes this
      // as totalWithTax - totalCoveredByPayments, which a well-formed order
      // never overshoots), but toAtomicUnits() below only rejects negative
      // integers, not zero, so the guard has to live here regardless of sign.
      return { amount, state: 'Declined' as const, errorMessage: 'No outstanding balance to charge for this order.' };
    }

    const rawPaymentPayload = (metadata as { paymentPayload?: unknown } | undefined)?.paymentPayload;
    if (!rawPaymentPayload) {
      return {
        amount,
        state: 'Declined' as const,
        errorMessage:
          'No x402 payment payload provided. Fetch payment requirements via the ' +
          'activeOrderX402PaymentRequirements query, sign a payment, and pass the result ' +
          'as metadata.paymentPayload.',
      };
    }

    let requiredAtomicAmount: string;
    try {
      requiredAtomicAmount = toAtomicUnits(amount, args.pegCurrencyDecimals, args.assetDecimals);
    } catch (err) {
      return { amount, state: 'Declined' as const, errorMessage: (err as Error).message };
    }

    if (!args.assetName || !args.assetVersion) {
      return {
        amount,
        state: 'Declined' as const,
        errorMessage:
          'x402 payment method is missing required "assetName"/"assetVersion" config. ' +
          "Reconfigure this payment method in the Admin UI with the asset's EIP-712 domain " +
          'name and version before accepting payments.',
      };
    }

    const requirements = buildPaymentRequirements(args, requiredAtomicAmount);

    const validationError = validatePaymentPayload(rawPaymentPayload, requirements);
    if (validationError) {
      return { amount, state: 'Declined' as const, errorMessage: validationError };
    }
    const paymentPayload = rawPaymentPayload as PaymentPayload;

    const facilitator = new HTTPFacilitatorClient({ url: args.facilitatorUrl || undefined });
    const facilitatorTimeoutSeconds = args.facilitatorTimeoutSeconds ?? 30;

    try {
      const result = await withTimeout(facilitator.verify(paymentPayload, requirements), facilitatorTimeoutSeconds, 'verify');
      if (!result.isValid) {
        return {
          amount,
          state: 'Declined' as const,
          errorMessage: result.invalidMessage || result.invalidReason || 'Payment verification failed.',
        };
      }
      return {
        amount,
        state: 'Authorized' as const,
        transactionId: result.payer,
        metadata: { paymentPayload, requirements, payer: result.payer },
      };
    } catch (err) {
      const message = err instanceof VerifyError ? err.message : (err as Error).message;
      return { amount, state: 'Declined' as const, errorMessage: message };
    }
  },
  settlePayment: async (_ctx, _order, payment, args): Promise<SettlePaymentResult | SettlePaymentErrorResult> => {
    // Deliberately not nested under metadata.public: the signed payment
    // payload shouldn't be exposed back to the Shop API.
    const stored = payment.metadata as
      | { paymentPayload?: PaymentPayload; requirements?: PaymentRequirements; transaction?: string }
      | undefined;

    // Nothing upstream prevents settlePayment being invoked twice for the same
    // payment (PaymentService calls the handler before validating the state
    // transition). Re-calling the facilitator with an already-settled payload
    // fails (nonce already used) and would turn a successful settlement into a
    // spurious error on the second call -- short-circuit instead.
    if (stored?.transaction) {
      // args.network (this payment method's configured network) rather than
      // reading it back off stored metadata -- the latter is only populated
      // by a merge of this handler's own prior settlePayment return value,
      // which is a fragile thing to depend on for a value that's already
      // available directly from config.
      return { success: true, metadata: { transaction: stored.transaction, network: args.network } };
    }

    if (!stored?.paymentPayload || !stored.requirements) {
      return {
        success: false,
        errorMessage: 'Missing stored x402 payment payload/requirements from the authorize step.',
      };
    }

    const facilitator = new HTTPFacilitatorClient({ url: args.facilitatorUrl || undefined });
    const facilitatorTimeoutSeconds = args.facilitatorTimeoutSeconds ?? 30;
    try {
      const result = await withTimeout(facilitator.settle(stored.paymentPayload, stored.requirements), facilitatorTimeoutSeconds, 'settle');
      if (!result.success) {
        return { success: false, errorMessage: result.errorMessage || result.errorReason || 'Settlement failed.' };
      }
      return { success: true, metadata: { transaction: result.transaction, network: result.network } };
    } catch (err) {
      const message = err instanceof SettleError ? err.message : (err as Error).message;
      return { success: false, errorMessage: message };
    }
  },
  cancelPayment: async (_ctx, _order, payment): Promise<CancelPaymentResult | CancelPaymentErrorResult> => {
    // x402 exact-scheme settlements are on-chain transfers and are irreversible
    // -- once `settlePayment` has run there is no way to "cancel" the money back,
    // so refuse rather than silently reporting success with no refund path.
    const settled = payment.metadata as { transaction?: string } | undefined;
    if (payment.state === 'Settled' || settled?.transaction) {
      return {
        success: false,
        errorMessage:
          'This payment has already been settled on-chain and cannot be cancelled. ' +
          'x402 exact-scheme transfers are irreversible -- issue a manual refund to the buyer instead.',
      };
    }
    // No funds have moved by this point (only `verify`, not `settle`, ran in
    // createPayment) so there's nothing on-chain to cancel.
    return { success: true };
  },
});

function buildPaymentRequirements(
  args: {
    payToAddress: string;
    network: string;
    asset: string;
    assetName: string;
    assetVersion: string;
    scheme: string;
    maxTimeoutSeconds: number;
  },
  amount: string,
): PaymentRequirements {
  return {
    scheme: args.scheme,
    network: args.network as PaymentRequirements['network'],
    asset: args.asset,
    amount,
    payTo: args.payToAddress,
    maxTimeoutSeconds: args.maxTimeoutSeconds,
    // EIP-3009 `transferWithAuthorization` signing/verification needs the asset
    // contract's own EIP-712 domain to reconstruct the same typed-data hash the
    // buyer signed -- without it the facilitator can't recover the signer and
    // verification fails with invalid_exact_evm_missing_eip712_domain, even for
    // a correctly-signed payment.
    extra: { name: args.assetName, version: args.assetVersion },
  };
}
