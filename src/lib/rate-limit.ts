/**
 * A small fixed-window rate limiter for the passphrase endpoint.
 *
 * **This is per-instance, and that is a real limitation, not an oversight.**
 * Serverless functions scale out, so an attacker who can provoke new instances
 * gets a fresh budget in each. It raises the cost of online guessing against a
 * single warm instance; it is not a distributed lockout and must not be relied on
 * as one.
 *
 * What actually makes brute force hopeless is passphrase entropy — which is why
 * `.env.example` says to generate a long random one rather than choose something.
 * This limiter exists to stop casual scripted guessing and to keep a wrong
 * passphrase from being retried thousands of times a second, not to be the
 * security boundary.
 *
 * A durable limiter belongs with the KV store in Phase 7b, where there will be
 * somewhere shared to keep counters.
 */

interface Window {
  count: number;
  resetAt: number;
}

const windows = new Map<string, Window>();

/** Bounds the map against an attacker cycling source addresses to exhaust memory. */
const MAX_TRACKED_KEYS = 10_000;

export interface RateLimitResult {
  allowed: boolean;
  /** Seconds until the window resets; for the `Retry-After` header. */
  retryAfter: number;
}

export function rateLimit(
  key: string,
  limit: number,
  windowSeconds: number,
  nowMs: number = Date.now(),
): RateLimitResult {
  const existing = windows.get(key);

  if (!existing || nowMs >= existing.resetAt) {
    if (windows.size >= MAX_TRACKED_KEYS) {
      // Cheap amortised cleanup: drop whatever has already expired. If nothing
      // has, the map is genuinely hot and the oldest entry goes.
      for (const [k, w] of windows) if (nowMs >= w.resetAt) windows.delete(k);
      if (windows.size >= MAX_TRACKED_KEYS) {
        const oldest = windows.keys().next();
        if (!oldest.done) windows.delete(oldest.value);
      }
    }
    windows.set(key, { count: 1, resetAt: nowMs + windowSeconds * 1000 });
    return { allowed: true, retryAfter: 0 };
  }

  existing.count += 1;
  return existing.count <= limit
    ? { allowed: true, retryAfter: 0 }
    : { allowed: false, retryAfter: Math.ceil((existing.resetAt - nowMs) / 1000) };
}

/** Test seam. Never called in production. */
export function resetRateLimits(): void {
  windows.clear();
}

/**
 * Best-effort client identity for limiting.
 *
 * `x-forwarded-for` is client-controlled in general; behind Vercel's proxy the
 * left-most entry is the real peer. Spoofing it only ever earns the attacker a
 * *separate* bucket rather than someone else's, so the failure mode is a weaker
 * limit, never a way to lock a legitimate user out.
 */
export function clientKey(request: Request): string {
  const forwarded = request.headers.get('x-forwarded-for');
  const first = forwarded?.split(',')[0]?.trim();
  return first || request.headers.get('x-real-ip') || 'unknown';
}
