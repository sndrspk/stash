/**
 * The check every serverless function runs first.
 *
 * The deployment URL is public and the account behind it can be deleted from, so
 * the rule is absolute: an unauthenticated request must be refused before any
 * outbound call happens. Not after fetching and then discarding the result — a
 * request that reaches Instapaper has already cost something and already told an
 * attacker the deployment is live and wired up.
 *
 * Usage is deliberately blunt, so that forgetting it is visible in review:
 *
 *   const refusal = requireSession(request);
 *   if (refusal) return refusal;
 */
import { readSessionCookie, verifySession } from './session';

/** Config errors are the operator's problem, and must never read as auth failures. */
export class ConfigError extends Error {}

/**
 * Reads a required environment variable.
 *
 * A missing secret is a deployment mistake, not a bad request, and conflating the
 * two produces the worst possible outcome: a gate that silently lets everything
 * through because the passphrase it compares against is `undefined`.
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new ConfigError(`${name} is not set`);
  return value;
}

/** A refusal, deliberately identical for every reason it could have happened. */
function unauthorized(): Response {
  return new Response(JSON.stringify({ error: 'unauthorized' }), {
    status: 401,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}

/**
 * Returns a 401 `Response` when the request may not proceed, or `undefined` when
 * it may.
 *
 * Returning the refusal rather than throwing keeps the happy path free of
 * try/catch and makes the guard impossible to satisfy by accident: a caller that
 * ignores the return value still has to write code that reads wrong.
 *
 * A misconfigured deployment returns 503, not 401 — "I am broken" and "you are not
 * allowed" are different facts, and the operator needs to be able to tell them
 * apart while an attacker learns nothing useful from either.
 */
export function requireSession(
  request: Request,
  nowSeconds = Date.now() / 1000,
): Response | undefined {
  let passphrase: string;
  try {
    passphrase = requireEnv('STASH_PASSPHRASE');
  } catch {
    return new Response(JSON.stringify({ error: 'not_configured' }), {
      status: 503,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }

  const token = readSessionCookie(request.headers.get('cookie'));
  return verifySession(token, passphrase, Math.floor(nowSeconds)) ? undefined : unauthorized();
}
