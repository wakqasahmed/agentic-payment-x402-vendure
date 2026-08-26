---
"vendure-payment-x402": patch
---

Apply the documented defaults for `pegCurrencyDecimals`, `scheme`, and `maxTimeoutSeconds` when an admin leaves them unset in the Admin UI. Vendure doesn't fall back to a config arg's `defaultValue` on its own; previously an unset `pegCurrencyDecimals` produced a `NaN` amount and a confusing decline message.
