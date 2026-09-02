/**
 * A small fixed-window rate limiter, used by the passphrase endpoint and by every
 * function that spends someone else's resources on our behalf.
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
 * **On making it durable.** An earlier note here said a shared limiter belonged with
 * the KV store, and the KV store now exists — but it is deliberately optional (site
 * sessions are a feature you can decline), so a limiter built on it would be absent
 * on exactly the deployments that have configured the least. Worse, it would put a
 * network round trip in front of every API call to defend a single-user app whose
 * real boundary is a long random passphrase. Per-instance and honestly documented is
 * the better trade here; if this ever serves more than one person, revisit it.
 */
import { createHmac } from 'node:crypto';

import { readSessionCookie } from './session.js';

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

/**
 * Identity for the endpoints behind the gate: the session, falling back to the IP.
 *
 * The session is the better key here and the address is the worse one, which is the
 * reverse of the unlock endpoint. A phone changes IP walking down a street — on a
 * mobile network it may change between two requests — so limiting an authenticated
 * reader by address either buckets them with everyone else behind a carrier NAT or
 * hands them a fresh budget every few minutes. The session token is stable for its
 * eight hours and identifies exactly the thing being limited.
 *
 * **Hashed, never used raw.** The token is a credential; a limiter has no business
 * holding one in a long-lived map, and a truncated HMAC is all a bucket key needs.
 * The salt is a constant rather than the passphrase because this is not a security
 * boundary — it is here so a heap dump does not hand over a live session.
 */
export function sessionKey(request: Request): string {
  const token = readSessionCookie(request.headers.get('cookie'));
  if (token === undefined || token === '') return `ip:${clientKey(request)}`;
  return `s:${createHmac('sha256', 'stash-ratelimit-v1').update(token).digest('base64url').slice(0, 22)}`;
}

/** A limit, named so the numbers can be read side by side rather than hunted for. */
export interface Budget {
  limit: number;
  windowSeconds: number;
}

/**
 * The budgets, in one place on purpose.
 *
 * These are not security limits — the gate is. They exist so that a bug in this app
 * cannot turn into a flood at somebody else's expense: a render loop calling sync, a
 * retry that forgot its backoff, a queue that replays without a lock. Every number is
 * set far above what the UI does when it is working and far below what would be
 * embarrassing to explain to Instapaper or to a publisher.
 */
export const BUDGETS = {
  /** A refresh is a person pressing a button, or an app start. */
  sync: { limit: 30, windowSeconds: 60 },
  /** Four eager fetches per front page, plus one per article opened. */
  text: { limit: 90, windowSeconds: 60 },
  /**
   * The loosest, because a first sync legitimately resolves hundreds — and the real
   * politeness control is elsewhere: `image-queue.ts` bounds concurrency and delays
   * per host, which is what a publisher actually feels.
   */
  images: { limit: 400, windowSeconds: 60 },
  /** One article the reader is waiting for, and a fetch of a publisher's whole page. */
  extract: { limit: 20, windowSeconds: 60 },
  /** Archive and delete. Deliberately generous: a queue draining after a train
      journey is a legitimate burst, and one call per article is the design. */
  action: { limit: 120, windowSeconds: 60 },
} as const satisfies Record<string, Budget>;

/**
 * Apply a budget, returning a 429 to send back or `undefined` to proceed.
 *
 * Shaped like `requireSession` — return the refusal rather than throw — so the two
 * read as one thing at the top of a handler, and so ignoring the result requires
 * writing code that looks wrong.
 */
export function throttle(request: Request, name: keyof typeof BUDGETS): Response | undefined {
  const budget: Budget = BUDGETS[name];
  const result = rateLimit(`${name}:${sessionKey(request)}`, budget.limit, budget.windowSeconds);
  if (result.allowed) return undefined;

  return new Response(
    JSON.stringify({
      error: 'too_many_requests',
      detail: `Slow down: ${String(budget.limit)} ${name} calls a minute.`,
    }),
    {
      status: 429,
      headers: {
        'content-type': 'application/json',
        'cache-control': 'no-store',
        'retry-after': String(result.retryAfter),
      },
    },
  );
}
