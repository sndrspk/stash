/**
 * The extractor with the jar attached.
 *
 * `1.1.1.1` stands in for a publisher throughout, for the reason the image-resolver
 * tests use it: it needs no DNS, so the SSRF guard's address check runs for real
 * instead of being mocked out. RFC 6265 gives an IP literal no domain hierarchy, so a
 * session stored for it matches that host exactly and nothing else — which is the
 * behaviour under test anyway.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GET } from '../api/extract';
import { SESSION_COOKIE, mintSession } from '../src/lib/session';
import { importKey, seal } from '../src/lib/secrets';
import { KEY_PREFIX } from '../src/lib/site-sessions';

const PASS = 'a long random deployment passphrase';
const KEY = 'a'.repeat(64);

const ENV = {
  STASH_PASSPHRASE: PASS,
  STASH_KV_URL: 'https://kv.example',
  STASH_KV_TOKEN: 'kvtoken',
  STASH_ENCRYPTION_KEY: KEY,
};

const saved: Record<string, string | undefined> = {};
const realFetch = globalThis.fetch;

/** Enough prose to clear the truncation heuristic. */
const FULL = `<p>${'Real article prose, at length, so the heuristic is satisfied. '.repeat(40)}</p>`;
const STUB = '<p>The rest of this article is for subscribers. Read more</p>';

const page = (body: string) =>
  `<html><head><title>An article</title></head><body><article>${body}</article></body></html>`;

let kv: Map<string, string>;
/** Every `Cookie:` header the publisher was sent, in order. */
let sentCookies: (string | null)[];

/**
 * One stub for both outbound calls: the key-value store and the publisher. They are
 * told apart by URL, which is also how the "were cookies actually sent?" assertion
 * gets to be about the wire rather than about our own bookkeeping.
 */
function stubNetwork(article: string, status = 200) {
  kv = new Map();
  sentCookies = [];

  globalThis.fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);

    if (url.startsWith('https://kv.example')) {
      const [op, ...args] = JSON.parse(String(init?.body)) as string[];
      const key = args[0] ?? '';
      if (op === 'GET') return Promise.resolve(Response.json({ result: kv.get(key) ?? null }));
      if (op === 'SET') {
        kv.set(key, args[1] ?? '');
        return Promise.resolve(Response.json({ result: 'OK' }));
      }
      if (op === 'DEL') return Promise.resolve(Response.json({ result: kv.delete(key) ? 1 : 0 }));
      if (op === 'SCAN') {
        const prefix = (args[2] ?? '*').replace(/\*$/, '');
        return Promise.resolve(
          Response.json({ result: ['0', [...kv.keys()].filter((k) => k.startsWith(prefix))] }),
        );
      }
      return Promise.resolve(Response.json({ error: 'unexpected command' }));
    }

    const headers = new Headers(init?.headers);
    sentCookies.push(headers.get('cookie'));
    return Promise.resolve(new Response(page(article), { status }));
  }) as unknown as typeof fetch;
}

async function storeSession(host: string, header: string) {
  const payload = JSON.stringify({ cookie: header, updated_at: Date.now() });
  kv.set(`${KEY_PREFIX}${host}`, await seal(payload, await importKey(KEY)));
}

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

const ask = (target = 'https://1.1.1.1/story', withSession = true): Request =>
  new Request(`https://stash.example/api/extract?url=${encodeURIComponent(target)}`, {
    headers: withSession ? { cookie: cookie() } : {},
  });

describe('the jar', () => {
  it('sends nothing when the store is empty', async () => {
    /*
     * The property the staged build order rests on: attaching the jar is a no-op at
     * the wire level until someone stores a session. If this ever fails, stage one has
     * stopped being the thing that was shipped and verified.
     */
    stubNetwork(FULL);
    const response = await GET(ask());

    expect(response.status).toBe(200);
    expect(sentCookies).toEqual([null]);
    expect((await response.json()).authenticated).toBe(false);
  });

  it('replays a stored session to the host it was saved for', async () => {
    stubNetwork(FULL);
    await storeSession('1.1.1.1', 'sess=abc; consent=1');

    const body = (await (await GET(ask())).json()) as { authenticated: boolean };

    expect(sentCookies).toEqual(['sess=abc; consent=1']);
    expect(body.authenticated).toBe(true);
  });

  it('sends nothing to a host it has no session for', async () => {
    stubNetwork(FULL);
    await storeSession('1.0.0.1', 'sess=abc');

    await GET(ask('https://1.1.1.1/story'));
    expect(sentCookies).toEqual([null]);
  });

  it('falls back to an anonymous fetch when the store is broken', async () => {
    /*
     * A misconfigured store must not turn a readable article into an error: fetching
     * with no cookies is independently useful, so this degrades to it. The settings
     * screen is where the configuration problem gets reported.
     */
    stubNetwork(FULL);
    delete process.env.STASH_ENCRYPTION_KEY;

    const response = await GET(ask());
    expect(response.status).toBe(200);
    expect(sentCookies).toEqual([null]);
  });

  it('never sends a session to Instapaper, because it never fetches them at all', async () => {
    stubNetwork(FULL);
    const response = await GET(ask('https://www.instapaper.com/read/1'));

    expect(response.status).toBe(403);
    expect(sentCookies).toEqual([]);
  });
});

describe('the expired-session diagnostic', () => {
  it('fires when a stub comes back despite a session', async () => {
    stubNetwork(STUB);
    await storeSession('1.1.1.1', 'sess=abc');

    const body = (await (await GET(ask())).json()) as {
      truncated: boolean;
      authenticated: boolean;
      sessionExpired: boolean;
    };

    expect(body.truncated).toBe(true);
    expect(body.authenticated).toBe(true);
    expect(body.sessionExpired).toBe(true);
  });

  it('does not fire for a stub fetched anonymously', async () => {
    // An anonymous stub is an ordinary paywall, not evidence about a session — there
    // is no session for it to be evidence about.
    stubNetwork(STUB);

    const body = (await (await GET(ask())).json()) as {
      truncated: boolean;
      sessionExpired: boolean;
    };
    expect(body.truncated).toBe(true);
    expect(body.sessionExpired).toBe(false);
  });

  it('does not fire when the session worked', async () => {
    stubNetwork(FULL);
    await storeSession('1.1.1.1', 'sess=abc');

    expect((await (await GET(ask())).json()).sessionExpired).toBe(false);
  });

  it('clears nothing — one bad extraction is not proof', async () => {
    /*
     * The spec is explicit, and the reason is that this signal has a second cause it
     * cannot tell apart: a page whose body is assembled by client-side script looks
     * exactly like a dead session.
     */
    stubNetwork(STUB);
    await storeSession('1.1.1.1', 'sess=abc');

    await GET(ask());
    expect(kv.has(`${KEY_PREFIX}1.1.1.1`)).toBe(true);
  });
});

describe('a failure', () => {
  it('still reports whether it was authenticated', async () => {
    stubNetwork(FULL, 403);
    await storeSession('1.1.1.1', 'sess=abc');

    const body = (await (await GET(ask())).json()) as {
      ok: boolean;
      tag: string;
      authenticated: boolean;
    };

    expect(body).toMatchObject({ ok: false, tag: 'HTTP 403', authenticated: true });
  });
});
