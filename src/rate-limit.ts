import { Logger } from '@vendure/core';
import type { RequestContext } from '@vendure/core';

const LOGGER_CTX = 'x402';

export interface X402RateLimitOptions {
  /** Max `createPayment` attempts per key per window. This is the one that
   * actually round-trips to the facilitator, so it gets the tighter default. */
  createPaymentMax: number;
  /** Max `activeOrderX402PaymentRequirements` queries per key per window. */
  requirementsMax: number;
  /** Fixed-window size, in milliseconds. */
  windowMs: number;
}

export const DEFAULT_RATE_LIMIT: X402RateLimitOptions = {
  createPaymentMax: 10,
  requirementsMax: 30,
  windowMs: 60_000,
};

let configured: X402RateLimitOptions = { ...DEFAULT_RATE_LIMIT };

/** Set by `X402Plugin.init()`. Kept in its own module (rather than read
 * directly off the plugin class) so `handler.ts` -- a plain object, not a
 * Nest-injectable -- can read it without importing `plugin.ts` and creating
 * a circular import. */
export function configureX402RateLimit(options?: Partial<X402RateLimitOptions>): void {
  configured = { ...DEFAULT_RATE_LIMIT, ...options };
}

interface Bucket {
  count: number;
  windowStart: number;
}

/**
 * Fixed-window rate limiter, in-memory only. This plugin has no existing
 * Redis/cache dependency (see package.json), and a single-process `Map` is
 * sufficient to stop the amplification this guards against -- an anonymous
 * Shop API session hammering the x402 facilitator with locally-valid-looking
 * payloads. It does NOT coordinate across multiple app instances behind a
 * load balancer; each instance enforces its own limit independently, which
 * is a deliberate scope limit, not an oversight.
 *
 * Fails OPEN on any internal error (e.g. corrupt bucket state): a broken
 * rate limiter blocking all checkout traffic is worse than temporarily
 * unlimited traffic. Mirrors the documented fail-open behavior of
 * agentic-pay-woocommerce's `CallbackRateLimiter`.
 */
export class FixedWindowRateLimiter {
  private buckets = new Map<string, Bucket>();

  constructor(private getOptions: () => { maxRequests: number; windowMs: number }) {}

  /** Returns `true` if this request is allowed (and consumes one slot),
   * `false` if the key is currently over its limit. */
  consume(key: string): boolean {
    try {
      const { maxRequests, windowMs } = this.getOptions();
      const now = Date.now();
      const bucket = this.buckets.get(key);
      if (!bucket || now - bucket.windowStart >= windowMs) {
        this.buckets.set(key, { count: 1, windowStart: now });
        return true;
      }
      if (bucket.count >= maxRequests) {
        return false;
      }
      bucket.count += 1;
      return true;
    } catch (err) {
      Logger.error(
        `x402 rate limiter failed internally, allowing the request through (fail-open): ${
          err instanceof Error ? err.message : String(err)
        }`,
        LOGGER_CTX,
      );
      return true;
    }
  }

  reset(): void {
    this.buckets.clear();
  }
}

export const createPaymentRateLimiter = new FixedWindowRateLimiter(() => ({
  maxRequests: configured.createPaymentMax,
  windowMs: configured.windowMs,
}));

export const requirementsRateLimiter = new FixedWindowRateLimiter(() => ({
  maxRequests: configured.requirementsMax,
  windowMs: configured.windowMs,
}));

/** Test-only: clears all rate-limit state and restores default options. */
export function resetX402RateLimiters(): void {
  createPaymentRateLimiter.reset();
  requirementsRateLimiter.reset();
  configured = { ...DEFAULT_RATE_LIMIT };
}

/**
 * Best-effort caller identity for rate-limiting an anonymous Shop API
 * caller: the session token when one exists (covers the normal case, since
 * Vendure issues an anonymous session token even to unauthenticated Shop API
 * callers), falling back to the request IP, falling back to a single shared
 * bucket if neither is available (e.g. a transport that doesn't expose
 * either). That shared fallback is intentionally coarse rather than
 * unlimited -- it still bounds total facilitator-bound traffic from
 * unidentifiable callers, it just can't distinguish between them.
 */
export function getRateLimitKey(ctx: RequestContext | undefined): string {
  try {
    const token = ctx?.session?.token;
    if (token) {
      return `session:${token}`;
    }
    const req = ctx?.req as { ip?: string; socket?: { remoteAddress?: string } } | undefined;
    const ip = req?.ip || req?.socket?.remoteAddress;
    if (ip) {
      return `ip:${ip}`;
    }
  } catch {
    // Fall through to the shared fallback below.
  }
  return 'unknown';
}
