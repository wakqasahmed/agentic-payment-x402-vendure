---
"agentic-payment-x402-vendure": minor
---

Validate the configured `asset` address against a known-good USDC contract address table for `network` in the x402 payment method handler (#40). Previously a misconfigured pairing (e.g. a testnet asset address with a mainnet network, or vice versa) compiled fine and only failed confusingly at the facilitator. Requests are now declined locally with a clear error when the pair is known to mismatch; networks outside the verified table are left unaffected.
