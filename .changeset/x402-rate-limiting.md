---
"agentic-payment-x402-vendure": minor
---

Add a fixed-window rate limit, keyed by session token (falling back to request IP, then a shared bucket), on `activeOrderX402PaymentRequirements` and `createPayment` (#38). Without this, an anonymous Shop API session could spam locally-valid-looking payloads that each still round-trip to the facilitator — a cost/rate-limit amplification vector against the facilitator relationship. Over-limit requests are now declined locally, before any facilitator call. Configurable via `X402Plugin.init({ rateLimit: { createPaymentMax, requirementsMax, windowMs } })`, with sane built-in defaults (10 `createPayment` attempts / 30 requirements queries per 60s window) so it works out of the box. The limiter is in-memory and per-process (no new Redis/cache dependency), and fails open on its own internal errors — a broken rate limiter blocking all checkout traffic would be worse than temporarily unlimited traffic.
