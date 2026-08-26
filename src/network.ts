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
