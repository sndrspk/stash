import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { GET as bookmarks } from '../api/bookmarks';
import { BUDGETS, resetRateLimits, sessionKey, throttle } from '../src/lib/rate-limit';
import { SESSION_COOKIE, mintSession } from '../src/lib/session';

const PASS = 'a long random deployment passphrase';
const OTHER = 'a different deployment passphrase entirely';

const saved: Record<string, string | undefined> = {};
const ENV = {
  STASH_PASSPHRASE: PASS,
  INSTAPAPER_CONSUMER_KEY: 'ck',
  INSTAPAPER_CONSUMER_SECRET: 'cs',
  INSTAPAPER_OAUTH_TOKEN: 'tok',
  INSTAPAPER_OAUTH_TOKEN_SECRET: 'toksec',
};
const realFetch = globalThis.fetch;

beforeEach(() => {
  resetRateLimits();
  for (const [name, value] of Object.entries(ENV)) {
    saved[name] = process.env[name];
    process.env[name] = value;
  }
});

afterEach(() => {
  for (const name of Object.keys(ENV)) {
    const previous = saved[name];
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
  globalThis.fetch = realFetch;
});

const token = (passphrase = PASS) => mintSession(passphrase, Math.floor(Date.now() / 1000));

const ask = (cookie?: string, ip = '203.0.113.7'): Request =>
  new Request('https://stash.example/api/bookmarks', {
    headers: {
      'x-forwarded-for': ip,
      ...(cookie === undefined ? {} : { cookie: `${SESSION_COOKIE}=${cookie}` }),
    },
  });

describe('sessionKey', () => {
  it('keys by the session, not the address', () => {
    /*
     * The reverse of the unlock endpoint's choice, and for a concrete reason: a phone
     * changes IP walking down a street, sometimes between two requests. Limiting an
     * authenticated reader by address either buckets them with everyone behind a
     * carrier NAT or hands them a fresh budget every few minutes.
     */
    const session = token();
    expect(sessionKey(ask(session, '203.0.113.7'))).toBe(sessionKey(ask(session, '198.51.100.2')));
  });

  it('gives different sessions different buckets', () => {
    expect(sessionKey(ask(token(PASS)))).not.toBe(sessionKey(ask(token(OTHER))));
  });

  it('never contains the token itself', () => {
    // A limiter has no business holding a live credential in a long-lived map.
    const session = token();
    expect(sessionKey(ask(session))).not.toContain(session);
    expect(sessionKey(ask(session)).startsWith('s:')).toBe(true);
  });

  it('falls back to the address when there is no session', () => {
    expect(sessionKey(ask(undefined, '203.0.113.7'))).toBe('ip:203.0.113.7');
  });
});

describe('throttle', () => {
  it('allows a burst well past anything the UI does', () => {
    // Every budget is set above normal use on purpose: this exists to stop a runaway
    // loop, not to ration a reader.
    const request = ask(token());
    for (let i = 0; i < BUDGETS.sync.limit; i += 1) {
      expect(throttle(request, 'sync'), `call ${String(i + 1)}`).toBeUndefined();
    }
  });

  it('refuses past the budget, with a Retry-After', async () => {
    const request = ask(token());
    for (let i = 0; i < BUDGETS.sync.limit; i += 1) throttle(request, 'sync');

    const refusal = throttle(request, 'sync');
    expect(refusal?.status).toBe(429);
    expect(Number(refusal?.headers.get('retry-after'))).toBeGreaterThan(0);
    expect(((await refusal?.json()) as { error: string }).error).toBe('too_many_requests');
  });

  it('keeps a separate budget per endpoint', () => {
    // Exhausting sync must not stop a reader opening an article.
    const request = ask(token());
    for (let i = 0; i < BUDGETS.sync.limit + 5; i += 1) throttle(request, 'sync');

    expect(throttle(request, 'sync')).toBeDefined();
    expect(throttle(request, 'text')).toBeUndefined();
  });

  it('keeps a separate budget per session', () => {
    const mine = ask(token(PASS));
    for (let i = 0; i < BUDGETS.sync.limit + 5; i += 1) throttle(mine, 'sync');

    expect(throttle(ask(token(OTHER)), 'sync')).toBeUndefined();
  });
});

describe('the endpoints', () => {
  it('refuses an over-budget caller before reaching Instapaper', async () => {
    /*
     * The ordering that matters, and the same one the gate uses: a request that is
     * going to be refused must not cost a round trip to somebody else's API first.
     */
    let calls = 0;
    globalThis.fetch = (() => {
      calls += 1;
      return Promise.resolve(new Response('[]', { status: 200 }));
    }) as unknown as typeof fetch;

    const request = ask(token());
    for (let i = 0; i < BUDGETS.sync.limit; i += 1) await bookmarks(request);
    const before = calls;

    expect((await bookmarks(request)).status).toBe(429);
    expect(calls).toBe(before);
  });

  it('checks the gate before the budget, so an anonymous flood cannot fill a bucket', async () => {
    // An unauthenticated request is refused for being unauthenticated; letting it
    // consume a budget first would let anyone lock the reader out of their own app.
    const anonymous = new Request('https://stash.example/api/bookmarks');
    for (let i = 0; i < BUDGETS.sync.limit + 10; i += 1) {
      expect((await bookmarks(anonymous)).status).toBe(401);
    }
    expect((await bookmarks(ask(token()))).status).not.toBe(429);
  });
});
