import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DELETE, POST } from '../api/unlock';
import { requireSession } from '../src/lib/guard';
import { SESSION_COOKIE, readSessionCookie } from '../src/lib/session';
import { resetRateLimits } from '../src/lib/rate-limit';

const PASS = 'a long random deployment passphrase';

let saved: string | undefined;

beforeEach(() => {
  saved = process.env.STASH_PASSPHRASE;
  process.env.STASH_PASSPHRASE = PASS;
  resetRateLimits();
});

afterEach(() => {
  if (saved === undefined) delete process.env.STASH_PASSPHRASE;
  else process.env.STASH_PASSPHRASE = saved;
});

/** Each request carries a distinct address so the rate limiter stays out of the way. */
let n = 0;
const attempt = (body: unknown) =>
  new Request('https://stash.example/api/unlock', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': `10.0.0.${++n % 250}` },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('POST /api/unlock', () => {
  it('issues a session for the right passphrase', () => {
    return POST(attempt({ passphrase: PASS })).then(async (res) => {
      expect(res.status).toBe(204);
      const cookie = res.headers.get('set-cookie');
      expect(cookie).toContain(`${SESSION_COOKIE}=`);
      expect(cookie).toContain('HttpOnly');
      expect(cookie).toContain('Secure');
      expect(cookie).toContain('SameSite=Lax');
    });
  });

  it('issues a session the guard then accepts', async () => {
    // The round trip that matters: what unlock mints, requireSession must admit.
    const res = await POST(attempt({ passphrase: PASS }));
    const token = readSessionCookie(res.headers.get('set-cookie'));
    expect(token).toBeTruthy();

    const guarded = new Request('https://stash.example/api/status', {
      headers: { cookie: `${SESSION_COOKIE}=${token}` },
    });
    expect(requireSession(guarded)).toBeUndefined();
  });

  it('refuses the wrong passphrase without setting a cookie', async () => {
    const res = await POST(attempt({ passphrase: 'not it' }));
    expect(res.status).toBe(401);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('refuses a near-miss', async () => {
    expect((await POST(attempt({ passphrase: PASS + ' ' }))).status).toBe(401);
    expect((await POST(attempt({ passphrase: PASS.slice(0, -1) }))).status).toBe(401);
  });

  it('treats a malformed body as a refusal, not a crash', async () => {
    expect((await POST(attempt('{not json'))).status).toBe(400);
    for (const body of [{}, { passphrase: null }, { passphrase: 42 }, { passphrase: {} }, []]) {
      expect((await POST(attempt(body))).status).toBe(401);
    }
  });

  it('answers 503 when no passphrase is configured, and issues nothing', async () => {
    delete process.env.STASH_PASSPHRASE;
    // The dangerous case: an empty submission must not match an unset variable.
    const res = await POST(attempt({ passphrase: '' }));
    expect(res.status).toBe(503);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('answers 503 for an empty passphrase variable', async () => {
    process.env.STASH_PASSPHRASE = '';
    const res = await POST(attempt({ passphrase: '' }));
    expect(res.status).toBe(503);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('rate-limits repeated attempts from one address', async () => {
    const from = (passphrase: string) =>
      new Request('https://stash.example/api/unlock', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.5' },
        body: JSON.stringify({ passphrase }),
      });

    for (let i = 0; i < 5; i++) {
      expect((await POST(from('wrong'))).status).toBe(401);
    }
    const limited = await POST(from('wrong'));
    expect(limited.status).toBe(429);
    expect(limited.headers.get('retry-after')).toBeTruthy();
  });

  it('rate-limits before checking, so a correct guess past the limit still fails', async () => {
    const from = (passphrase: string) =>
      new Request('https://stash.example/api/unlock', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.6' },
        body: JSON.stringify({ passphrase }),
      });

    for (let i = 0; i < 5; i++) await POST(from('wrong'));
    const res = await POST(from(PASS));
    expect(res.status).toBe(429);
    expect(res.headers.get('set-cookie')).toBeNull();
  });

  it('never caches a response', async () => {
    for (const body of [{ passphrase: PASS }, { passphrase: 'wrong' }]) {
      expect((await POST(attempt(body))).headers.get('cache-control')).toBe('no-store');
    }
  });
});

describe('DELETE /api/unlock', () => {
  it('clears the cookie', () => {
    const res = DELETE();
    expect(res.status).toBe(204);
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');
  });

  it('produces a cookie the guard rejects', () => {
    const cleared = readSessionCookie(DELETE().headers.get('set-cookie'));
    const request = new Request('https://stash.example/api/status', {
      headers: { cookie: `${SESSION_COOKIE}=${cleared ?? ''}` },
    });
    expect(requireSession(request)?.status).toBe(401);
  });
});
