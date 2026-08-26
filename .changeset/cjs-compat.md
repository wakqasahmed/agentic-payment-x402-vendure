---
"vendure-payment-x402": patch
---

Ship a dual CommonJS+ESM build instead of ESM-only. `require('vendure-payment-x402')` previously threw `ERR_REQUIRE_ESM` on a standard CommonJS Vendure scaffold (Node <22.12). Also declares `engines.node >= 20.0.0`.
