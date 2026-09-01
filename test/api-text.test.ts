import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GET } from '../api/text';
import { SESSION_COOKIE, mintSession } from '../src/lib/session';

const PASS = 'a long random deployment passphrase';

const ENV = {
  STASH_PASSPHRASE: PASS,
  INSTAPAPER_CONSUMER_KEY: 'ck',
  INSTAPAPER_CONSUMER_SECRET: 'cs',
  INSTAPAPER_OAUTH_TOKEN: 'tok',
  INSTAPAPER_OAUTH_TOKEN_SECRET: 'toksec',
};

const saved: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;

beforeEach(() => {
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
  vi.restoreAllMocks();
});

const cookie = () => `${SESSION_COOKIE}=${mintSession(PASS, Math.floor(Date.now() / 1000))}`;

const ask = (query: string, withSession = true): Request =>
  new Request(`https://stash.example/api/text?${query}`, {
    headers: withSession ? { cookie: cookie() } : {},
  });

function stubInstapaper(body: string, status = 200) {
  const spy = vi.fn(() => Promise.resolve(new Response(body, { status })));
  globalThis.fetch = spy as unknown as typeof fetch;
  return spy;
}

describe('the gate', () => {
  it('refuses an unauthenticated request without calling Instapaper', async () => {
    const spy = stubInstapaper('<p>text</p>');
    expect((await GET(ask('bookmark_id=1', false))).status).toBe(401);
    expect(spy).not.toHaveBeenCalled();
  });

  it('reports a missing credential as configuration, not as a refusal', async () => {
    delete process.env.INSTAPAPER_CONSUMER_KEY;
    const response = await GET(ask('bookmark_id=1'));

    expect(response.status).toBe(503);
    // Naming the variable is the point: the operator is the only reader, and the
    // only person who can fix it.
    expect(await response.json()).toMatchObject({
      error: 'not_configured',
      detail: 'INSTAPAPER_CONSUMER_KEY is not set',
    });
  });
});

describe('the bookmark id', () => {
  it.each([
    ['', 'missing'],
    ['bookmark_id=', 'empty'],
    ['bookmark_id=abc', 'not a number'],
    ['bookmark_id=0', 'zero'],
    ['bookmark_id=-3', 'negative'],
    ['bookmark_id=1.5', 'fractional'],
  ])('rejects %s (%s) without calling Instapaper', async (query) => {
    const spy = stubInstapaper('<p>text</p>');
    expect((await GET(ask(query))).status).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('the text', () => {
  it('returns the fragment Instapaper sent', async () => {
    stubInstapaper('<div id="story"><p>The article.</p></div>');
    const response = await GET(ask('bookmark_id=42'));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      bookmark_id: 42,
      html: '<div id="story"><p>The article.</p></div>',
    });
  });

  it('treats a 400 as "no text for this one", which is an answer', async () => {
    // A paywall, a video page, a PDF. Phase 7's extraction is what eventually
    // turns this into an article; until then it is an honest empty.
    stubInstapaper('', 400);
    const response = await GET(ask('bookmark_id=42'));

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ html: null, reason: 'no_text' });
  });

  it('treats an empty 200 body the same way', async () => {
    stubInstapaper('   ');
    expect(await (await GET(ask('bookmark_id=42'))).json()).toMatchObject({
      html: null,
      reason: 'empty',
    });
  });

  it('reports any other Instapaper status as a failure, not as empty text', async () => {
    stubInstapaper('nope', 500);
    const response = await GET(ask('bookmark_id=42'));

    expect(response.status).toBe(502);
    expect(await response.json()).toMatchObject({ error: 'instapaper', status: 500 });
  });

  it('reports an unreachable API as 504', async () => {
    globalThis.fetch = vi.fn(() =>
      Promise.reject(new TypeError('fetch failed')),
    ) as unknown as typeof fetch;

    expect((await GET(ask('bookmark_id=42'))).status).toBe(504);
  });

  it('signs the call and sends the id as a form parameter', async () => {
    const spy = stubInstapaper('<p>ok</p>');
    await GET(ask('bookmark_id=42'));

    expect(spy).toHaveBeenCalledTimes(1);
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(url)).toBe('https://www.instapaper.com/api/1.1/bookmarks/get_text');
    expect(String((init.headers as Record<string, string>).authorization)).toContain('OAuth ');
    expect(String(init.body)).toBe('bookmark_id=42');
  });
});
