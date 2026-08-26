---
"vendure-payment-x402": patch
---

Make `settlePayment` idempotent against being invoked twice for the same payment (an admin double-click, retried event delivery, or a duplicate auto-settle event). Re-calling the facilitator with an already-settled payload previously turned a successful settlement into a spurious error and discarded the recorded settlement metadata.
