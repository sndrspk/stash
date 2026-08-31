/**
 * The session cookie behind the passphrase gate.
 *
 * Stash is single-tenant, so a "session" carries no identity — there is only ever
 * one user. It asserts one thing: whoever holds this cookie knew the passphrase
 * recently. That makes it a signed expiry stamp rather than a session record, and
 * means no server-side store is needed to validate one.
 *
 * The signing key is derived from `STASH_PASSPHRASE` itself, which gives rotation
 * the behaviour you would want anyway: change the passphrase and every outstanding
 * cookie stops verifying, with nothing to purge.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Eight hours: long enough not to nag, short enough that a stolen cookie ages out. */
export const SESSION_TTL_SECONDS = 8 * 60 * 60;

export const SESSION_COOKIE = 'stash_session';

const b64url = (buf: Buffer) => buf.toString('base64url');

/**
 * Domain-separated so the session key can never collide with any other use of the
 * passphrase. The version label is here so a future format change can invalidate
 * old cookies deliberately rather than by accident.
 */
function sessionKey(passphrase: string): Buffer {
  return createHmac('sha256', 'stash-session-v1').update(passphrase).digest();
}

/**
 * Mints `<payload>.<mac>`, where the payload is the expiry.
 *
 * `nowSeconds` is injected rather than read from the clock so expiry is testable
 * without waiting eight hours or stubbing time globally.
 */
export function mintSession(passphrase: string, nowSeconds: number): string {
  const payload = b64url(Buffer.from(JSON.stringify({ exp: nowSeconds + SESSION_TTL_SECONDS })));
  const mac = b64url(createHmac('sha256', sessionKey(passphrase)).update(payload).digest());
  return `${payload}.${mac}`;
}

/**
 * True only for a token this deployment minted, that has not expired.
 *
 * Order matters: the MAC is checked before the payload is parsed, so unverified
 * bytes never reach `JSON.parse`. Any malformed input is simply false — a forged
 * cookie and a corrupted one are not worth distinguishing to the caller, and
 * saying which would tell an attacker how far they got.
 */
export function verifySession(
  token: string | undefined,
  passphrase: string,
  nowSeconds: number,
): boolean {
  if (!token) return false;

  const dot = token.indexOf('.');
  if (dot < 1 || dot === token.length - 1) return false;

  const payload = token.slice(0, dot);
  const presented = Buffer.from(token.slice(dot + 1), 'base64url');
  const expected = createHmac('sha256', sessionKey(passphrase)).update(payload).digest();

  // Compare lengths first: timingSafeEqual throws on a mismatch, and a thrown
  // exception here would be a signal in itself.
  if (presented.length !== expected.length) return false;
  if (!timingSafeEqual(presented, expected)) return false;

  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof claims !== 'object' || claims === null) return false;
    const exp = (claims as { exp?: unknown }).exp;
    return typeof exp === 'number' && Number.isFinite(exp) && exp > nowSeconds;
  } catch {
    return false;
  }
}

/**
 * Serializes the Set-Cookie value.
 *
 * `HttpOnly` keeps it away from any script, including injected article HTML.
 * `SameSite=Lax` blocks it from riding along on a cross-site POST — relevant
 * because the functions behind this gate archive and delete bookmarks.
 * `Secure` is unconditional. Stash is served over HTTPS, and making the attribute
 * conditional would mean shipping a code path whose whole purpose is to weaken the
 * cookie — one that has to be exactly right forever.
 *
 * One local-development wrinkle, verified in Chromium rather than assumed: the
 * trustworthy-origin exception that lets a `Secure` cookie work over plain HTTP
 * applies to the *hostname* `localhost`, not to the literal IP `127.0.0.1`. On
 * `http://127.0.0.1` the browser accepts the cookie and then silently declines to
 * send it back, so unlocking appears to succeed and every subsequent call is a 401.
 * `vercel dev` serves on `localhost`, so the normal workflow is unaffected — but if
 * you ever find yourself in that loop, check the address bar before the code.
 */
export function sessionCookie(token: string, maxAgeSeconds = SESSION_TTL_SECONDS): string {
  return [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
  ].join('; ');
}

/** An immediately-expiring cookie, for signing out. */
export function clearedSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`;
}

/**
 * Reads our cookie out of a `Cookie:` header.
 *
 * Deliberately tolerant of the shapes real headers take — spaces after semicolons,
 * other cookies either side — but not of a name that merely ends with ours, which
 * is why the name is compared exactly rather than with `includes`.
 */
export function readSessionCookie(header: string | null | undefined): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === SESSION_COOKIE) return part.slice(eq + 1).trim();
  }
  return undefined;
}
