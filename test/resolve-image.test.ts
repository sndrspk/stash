import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GET } from '../api/resolve-image';
import { SESSION_COOKIE, mintSession } from '../src/lib/session';

const PASS = 'a long random deployment passphrase';

let saved: string | undefined;
const realFetch = globalThis.fetch;

beforeEach(() => {
  saved = process.env.STASH_PASSPHRASE;
  process.env.STASH_PASSPHRASE = PASS;
});

afterEach(() => {
  if (saved === undefined) delete process.env.STASH_PASSPHRASE;
  else process.env.STASH_PASSPHRASE = saved;
  globalThis.fetch = realFetch;
  vi.restoreAllMocks();
});

const cookie = () => `${SESSION_COOKIE}=${mintSession(PASS, Math.floor(Date.now() / 1000))}`;

const ask = (target: string, withSession = true): Request =>
  new Request(`https://stash.example/api/resolve-image?url=${encodeURIComponent(target)}`, {
    headers: withSession ? { cookie: cookie() } : {},
  });

/** Replaces the network, and records whether it was reached at all. */
function stubFetch(body: string, init: ResponseInit = {}) {
  const spy = vi.fn(() => Promise.resolve(new Response(body, { status: 200, ...init })));
  globalThis.fetch = spy as unknown as typeof fetch;
  return spy;
}

describe('the gate', () => {
  it('refuses an unauthenticated request without fetching anything', async () => {
    const spy = stubFetch('<html></html>');
    const response = await GET(ask('https://1.1.1.1/story', false));

    expect(response.status).toBe(401);
    // The point of the ordering: a public URL fetcher is a useful thing to steal.
    expect(spy).not.toHaveBeenCalled();
  });

  it('answers 503 rather than 401 when the deployment has no passphrase', async () => {
    delete process.env.STASH_PASSPHRASE;
    expect((await GET(ask('https://1.1.1.1/story'))).status).toBe(503);
  });
});

describe('the SSRF guard', () => {
  // The phase's "done when", asserted literally: rejected, and rejected before any
  // fetch happens rather than after one that was then discarded.
  it.each([
    ['http://169.254.169.254/latest/meta-data/', 'the cloud metadata endpoint'],
    ['http://localhost:3000/', 'localhost'],
    ['http://127.0.0.1/', 'loopback'],
    ['http://10.0.0.1/', 'a private address'],
    ['http://[::1]/', 'IPv6 loopback'],
  ])('refuses %s (%s) before any fetch', async (target) => {
    const spy = stubFetch('<html></html>');
    const response = await GET(ask(target));

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: 'blocked' });
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses a non-http scheme', async () => {
    const spy = stubFetch('<html></html>');
    expect((await GET(ask('file:///etc/passwd'))).status).toBe(403);
    expect(spy).not.toHaveBeenCalled();
  });

  it('refuses instapaper.com outright, as the terms require', async () => {
    const spy = stubFetch('<html></html>');
    expect((await GET(ask('https://www.instapaper.com/read/123'))).status).toBe(403);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('bad requests', () => {
  it('needs a url', async () => {
    const request = new Request('https://stash.example/api/resolve-image', {
      headers: { cookie: cookie() },
    });
    expect((await GET(request)).status).toBe(400);
  });

  it('rejects something that is not a URL', async () => {
    expect((await GET(ask('not a url'))).status).toBe(400);
  });
});

describe('resolving', () => {
  it('returns the declared image', async () => {
    stubFetch(
      '<html><head><meta property="og:image" content="https://cdn.example/a.jpg"></head></html>',
    );
    const response = await GET(ask('https://1.1.1.1/story'));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      status: 'ok',
      image_url: 'https://cdn.example/a.jpg',
      from: 'og:image',
    });
  });

  it('answers none — a real, cacheable result — for a page with no image', async () => {
    stubFetch('<html><body><p>Words.</p></body></html>');
    const response = await GET(ask('https://1.1.1.1/story'));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: 'none', image_url: null });
  });

  it('resolves a relative image against the URL actually fetched', async () => {
    stubFetch('<html><head><meta property="og:image" content="/img/a.jpg"></head></html>');
    const body = (await (await GET(ask('https://1.1.1.1/news/story'))).json()) as {
      image_url: string;
    };
    expect(body.image_url).toBe('https://1.1.1.1/img/a.jpg');
  });

  it('reports a publisher error as retryable rather than as "no image"', async () => {
    // The failure worth designing against: a 403 cached as `none` is silent and it
    // lasts, so it must not be a 200.
    stubFetch('nope', { status: 403 });
    const response = await GET(ask('https://1.1.1.1/story'));

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: 'http', status: 403 });
  });

  it('reports an unreachable host as retryable', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.reject(new TypeError('fetch failed')),
    ) as unknown as typeof fetch;
    expect((await GET(ask('https://1.1.1.1/story'))).status).toBe(502);
  });

  it('reports a timeout as 504, not as a refusal', async () => {
    globalThis.fetch = vi.fn(() => {
      const error = new Error('The operation was aborted due to timeout');
      error.name = 'TimeoutError';
      return Promise.reject(error);
    }) as unknown as typeof fetch;

    expect((await GET(ask('https://1.1.1.1/story'))).status).toBe(504);
  });
});

describe('redirects', () => {
  it('re-validates every hop, so a permitted URL cannot bounce into private space', async () => {
    const spy = vi.fn((input: string | URL) => {
      const url = String(input);
      if (url.startsWith('https://1.1.1.1/')) {
        return Promise.resolve(
          new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }),
        );
      }
      throw new Error(`should never be fetched: ${url}`);
    });
    globalThis.fetch = spy as unknown as typeof fetch;

    const response = await GET(ask('https://1.1.1.1/story'));

    expect(response.status).toBe(403);
    // One hop attempted, and the metadata endpoint never reached.
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
