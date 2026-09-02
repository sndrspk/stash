import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { DELETE, GET, POST } from '../api/sessions';
import { SESSION_COOKIE, mintSession } from '../src/lib/session';

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

/**
 * A Redis-over-HTTP server backed by a Map.
 *
 * Stubbed at `fetch` rather than at the store, so these run the whole path the
 * deployment does: the REST client, the encryption, the namespace and the handler.
 * The Map is also what lets the leak test below be conclusive — it holds exactly what
 * the hosting provider would.
 */
let store: Map<string, string>;

function stubKv() {
  store = new Map();
  globalThis.fetch = ((_url: string | URL, init?: RequestInit) => {
    const [op, ...args] = JSON.parse(String(init?.body)) as string[];
    const key = args[0] ?? '';

    switch (op) {
      case 'GET':
        return Promise.resolve(Response.json({ result: store.get(key) ?? null }));
      case 'SET':
        store.set(key, args[1] ?? '');
        return Promise.resolve(Response.json({ result: 'OK' }));
      case 'DEL':
        return Promise.resolve(Response.json({ result: store.delete(key) ? 1 : 0 }));
      case 'SCAN': {
        const pattern = (args[2] ?? '*').replace(/\*$/, '');
        const keys = [...store.keys()].filter((k) => k.startsWith(pattern));
        return Promise.resolve(Response.json({ result: ['0', keys] }));
      }
      default:
        return Promise.resolve(Response.json({ error: `unexpected ${op ?? '?'}` }));
    }
  }) as unknown as typeof fetch;
}

beforeEach(() => {
  for (const [name, value] of Object.entries(ENV)) {
    saved[name] = process.env[name];
    process.env[name] = value;
  }
  stubKv();
});

afterEach(() => {
  for (const name of Object.keys(ENV)) {
    const previous = saved[name];
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
  globalThis.fetch = realFetch;
});

const cookie = () => `${SESSION_COOKIE}=${mintSession(PASS, Math.floor(Date.now() / 1000))}`;

const get = (withSession = true) =>
  new Request('https://stash.example/api/sessions', {
    headers: withSession ? { cookie: cookie() } : {},
  });

const post = (body: unknown, withSession = true) =>
  new Request('https://stash.example/api/sessions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(withSession ? { cookie: cookie() } : {}),
    },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

const del = (host: string, withSession = true) =>
  new Request(`https://stash.example/api/sessions?host=${encodeURIComponent(host)}`, {
    method: 'DELETE',
    headers: withSession ? { cookie: cookie() } : {},
  });

describe('the gate', () => {
  it('refuses every verb without a session', async () => {
    // An ungated POST would let anyone attach their own cookies to this deployment's
    // outbound fetches, which is a worse hole than reading the host list.
    expect((await GET(get(false))).status).toBe(401);
    expect((await POST(post({ host: 'a.example', cookie: 'a=1' }, false))).status).toBe(401);
    expect((await DELETE(del('a.example', false))).status).toBe(401);
    expect(store.size).toBe(0);
  });
});

describe('POST', () => {
  it('stores a pasted header and answers with names only', async () => {
    const response = await POST(post({ host: 'www.ft.com', cookie: 'FTSession=abc; FTUser=def' }));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      host: 'www.ft.com',
      cookies: ['FTSession', 'FTUser'],
      added: 2,
    });
  });

  it('takes the host from an article URL, because that is what people paste', async () => {
    const response = await POST(
      post({ host: 'https://www.ft.com/content/whatever', cookie: 'a=1' }),
    );
    expect((await response.json()).host).toBe('www.ft.com');
  });

  it('refuses a host that is not a hostname', async () => {
    // Stored under a key no request will ever match, a typo fails silently — the worst
    // outcome for a credential store.
    const response = await POST(post({ host: 'not a host', cookie: 'a=1' }));
    expect(response.status).toBe(400);
    expect(store.size).toBe(0);
  });

  it('refuses a paste with no cookies in it, and says where to look', async () => {
    const response = await POST(post({ host: 'www.ft.com', cookie: 'https://www.ft.com/x' }));
    expect(response.status).toBe(400);
    expect((await response.json()).detail).toMatch(/Network tab/);
  });

  it('refuses a body that is not JSON, and a body missing either field', async () => {
    expect((await POST(post('{['))).status).toBe(400);
    expect((await POST(post({ host: 'www.ft.com' }))).status).toBe(400);
    expect((await POST(post({ cookie: 'a=1' }))).status).toBe(400);
  });

  it('refuses an absurdly long paste', async () => {
    const response = await POST(post({ host: 'www.ft.com', cookie: `a=${'x'.repeat(40_000)}` }));
    expect(response.status).toBe(413);
  });
});

describe('GET', () => {
  it('lists hosts with cookie names and never a value', async () => {
    await POST(post({ host: 'www.ft.com', cookie: 'FTSession=supersecretvalue' }));

    const body = await (await GET(get())).text();

    expect(JSON.parse(body).hosts[0]).toMatchObject({
      host: 'www.ft.com',
      cookies: ['FTSession'],
    });
    // The whole rule, checked on the actual bytes that would go over the wire.
    expect(body).not.toContain('supersecretvalue');
  });

  it('is empty when nothing is stored', async () => {
    expect(await (await GET(get())).json()).toEqual({ configured: true, hosts: [], cleared: [] });
  });

  it('never lets a value reach the provider either', async () => {
    await POST(post({ host: 'www.ft.com', cookie: 'FTSession=supersecretvalue' }));
    expect([...store.values()].join()).not.toContain('supersecretvalue');
  });
});

describe('DELETE', () => {
  it('forgets one host', async () => {
    await POST(post({ host: 'www.ft.com', cookie: 'a=1' }));

    expect((await DELETE(del('www.ft.com'))).status).toBe(204);
    expect((await (await GET(get())).json()).hosts).toEqual([]);
  });

  it('is 404 when there was nothing stored', async () => {
    expect((await DELETE(del('www.ft.com'))).status).toBe(404);
  });

  it('needs a host', async () => {
    const response = await DELETE(
      new Request('https://stash.example/api/sessions', {
        method: 'DELETE',
        headers: { cookie: cookie() },
      }),
    );
    expect(response.status).toBe(400);
  });
});

describe('a deployment with no store', () => {
  beforeEach(() => {
    delete process.env.STASH_KV_URL;
    delete process.env.STASH_KV_TOKEN;
  });

  it('answers GET with a normal 200 saying so', async () => {
    /*
     * Not an error: extraction with an empty jar is stage one of this design and is
     * independently useful, so the settings screen needs something true to render
     * rather than "could not load".
     */
    const response = await GET(get());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ configured: false, hosts: [], cleared: [] });
  });

  it('tells a POST plainly that there is nowhere to put it', async () => {
    const response = await POST(post({ host: 'www.ft.com', cookie: 'a=1' }));
    expect(response.status).toBe(501);
    expect((await response.json()).error).toBe('no_store');
  });
});

describe('a store with no encryption key', () => {
  beforeEach(() => {
    delete process.env.STASH_ENCRYPTION_KEY;
  });

  it('refuses to write rather than storing plaintext credentials', async () => {
    const response = await POST(post({ host: 'www.ft.com', cookie: 'a=1' }));
    expect(response.status).toBe(503);
    expect(store.size).toBe(0);
  });

  it('says so on the settings screen instead of failing it', async () => {
    const body = (await (await GET(get())).json()) as { configured: boolean; detail?: string };
    expect(body.configured).toBe(false);
    expect(body.detail).toMatch(/STASH_ENCRYPTION_KEY/);
  });
});
