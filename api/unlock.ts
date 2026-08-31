/**
 * The passphrase gate. The only function that answers without a session, because
 * it is the one that issues them.
 *
 * POST { passphrase } -> 204 + Set-Cookie, or 401.
 * DELETE               -> 204 + cleared cookie (sign out).
 */
import { requireEnv } from '../src/lib/guard';
import { secretsMatch } from '../src/lib/oauth';
import { clientKey, rateLimit } from '../src/lib/rate-limit';
import { clearedSessionCookie, mintSession, sessionCookie } from '../src/lib/session';

/** Five attempts a minute: invisible to a person typing, tedious for a script. */
const ATTEMPT_LIMIT = 5;
const ATTEMPT_WINDOW_SECONDS = 60;

const json = (body: unknown, status: number, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...headers },
  });

export async function POST(request: Request): Promise<Response> {
  let expected: string;
  try {
    expected = requireEnv('STASH_PASSPHRASE');
  } catch {
    // Never fall through to a comparison against undefined — that would be a gate
    // that opens for everyone precisely when it is misconfigured.
    return json({ error: 'not_configured' }, 503);
  }

  const limit = rateLimit(clientKey(request), ATTEMPT_LIMIT, ATTEMPT_WINDOW_SECONDS);
  if (!limit.allowed) {
    return json({ error: 'too_many_attempts' }, 429, { 'retry-after': String(limit.retryAfter) });
  }

  let submitted: unknown;
  try {
    submitted = ((await request.json()) as { passphrase?: unknown }).passphrase;
  } catch {
    return json({ error: 'bad_request' }, 400);
  }

  // A wrong passphrase and a malformed one are the same answer: an attacker learns
  // nothing from the difference, and there is nothing for a real user to fix
  // differently.
  if (typeof submitted !== 'string' || !secretsMatch(submitted, expected)) {
    return json({ error: 'unauthorized' }, 401);
  }

  const token = mintSession(expected, Math.floor(Date.now() / 1000));
  return new Response(null, {
    status: 204,
    headers: { 'set-cookie': sessionCookie(token), 'cache-control': 'no-store' },
  });
}

export function DELETE(): Response {
  return new Response(null, {
    status: 204,
    headers: { 'set-cookie': clearedSessionCookie(), 'cache-control': 'no-store' },
  });
}
