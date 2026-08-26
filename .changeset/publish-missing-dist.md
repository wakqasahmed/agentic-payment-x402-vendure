---
"vendure-payment-x402": patch
---

Fix `0.2.0` being published with no `dist/` directory -- the Release workflow ran `changeset publish` directly after `npm ci`, never running `npm run build`, so there was nothing for npm to pack. `require()`/`import()` both failed for anyone who installed `0.2.0`. Added the missing `npm run build` step to the workflow, plus a `prepublishOnly` script as a safety net against this recurring.
