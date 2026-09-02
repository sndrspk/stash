/**
 * The key-value binding.
 *
 * Stash has no database and does not want one. There is one user and one access
 * pattern — *give me the cookies for this host* — so the store is a dictionary, and a
 * relational table would be two columns that are never joined, sorted or queried.
 * It cannot be an environment variable either, the way the Instapaper token is: sessions
 * are added and replaced while the app is running.
 *
 * Deliberately dependency-free. Vercel KV and Upstash both speak the same Redis-over-HTTP
 * protocol — a POST whose JSON body is the command as an array — so a client for it is
 * thirty lines of `fetch`, and adding `@vercel/kv` would buy a lock-in and a bundle for
 * nothing. Cloudflare KV is a different shape; when that matters, it is another
 * implementation of `KvStore` and nothing above this file changes.
 *
 * What is stored here is ciphertext (`lib/secrets.ts`) under keys this module never
 * interprets. The namespacing rule from the spec lives one layer up in
 * `lib/site-sessions.ts` and is the reason `keys()` takes a prefix at all.
 */

/** The whole surface. Anything a session store needs, and nothing else. */
export interface KvStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  /** True when a key was there to remove. */
  delete(key: string): Promise<boolean>;
  /** Every key under a prefix. Unsorted; callers that care sort. */
  keys(prefix: string): Promise<string[]>;
}

/** A store is missing or misconfigured. Distinct from "the store said no". */
export class KvUnavailableError extends Error {}

/**
 * The environment variable pairs a deployment actually has.
 *
 * `KV_REST_API_*` is what Vercel injects when a KV store is attached to a project;
 * `UPSTASH_REDIS_REST_*` is what Upstash gives you directly. `STASH_KV_*` is first so a
 * deployment with both attached can say which one Stash uses.
 */
const ENV_PAIRS = [
  ['STASH_KV_URL', 'STASH_KV_TOKEN'],
  ['KV_REST_API_URL', 'KV_REST_API_TOKEN'],
  ['UPSTASH_REDIS_REST_URL', 'UPSTASH_REDIS_REST_TOKEN'],
] as const;

export interface KvCredentials {
  url: string;
  token: string;
  /** Which variable pair was used, for the diagnostics screen. Never the token. */
  source: string;
}

/** The first configured pair, or null. Reading env is separated so it can be tested. */
export function readKvCredentials(env: Record<string, string | undefined>): KvCredentials | null {
  for (const [urlVar, tokenVar] of ENV_PAIRS) {
    const url = env[urlVar]?.trim();
    const token = env[tokenVar]?.trim();
    if (url !== undefined && url !== '' && token !== undefined && token !== '') {
      return { url: url.replace(/\/+$/, ''), token, source: urlVar };
    }
  }
  return null;
}

/**
 * A Redis-over-HTTP store.
 *
 * One quirk worth naming: `SCAN` is used rather than `KEYS`, and it is cursored. `KEYS`
 * is a single round trip and would be simpler, but it blocks the server for the whole
 * scan — harmless at a dozen keys and a foot-gun the day this store holds something
 * else. The cursor loop is bounded so a server that never returns cursor `0` cannot
 * spin here forever.
 */
export function restKv(credentials: KvCredentials, fetchImpl: typeof fetch = fetch): KvStore {
  async function command(...args: (string | number)[]): Promise<unknown> {
    const response = await fetchImpl(credentials.url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${credentials.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(args.map(String)),
    });

    if (!response.ok) {
      // The body may carry the provider's own error text; the token never appears in
      // it, but the URL might, so only the status is passed on.
      throw new KvUnavailableError(`the key-value store answered HTTP ${String(response.status)}`);
    }

    const body = (await response.json()) as { result?: unknown; error?: string };
    if (typeof body.error === 'string') throw new KvUnavailableError(body.error);
    return body.result;
  }

  return {
    async get(key) {
      const result = await command('GET', key);
      return typeof result === 'string' ? result : null;
    },

    async set(key, value) {
      await command('SET', key, value);
    },

    async delete(key) {
      const result = await command('DEL', key);
      return typeof result === 'number' && result > 0;
    },

    async keys(prefix) {
      const found = new Set<string>();
      let cursor = '0';
      // A hundred round trips is far past anything this store will hold, and it is a
      // bound rather than a budget: reaching it means the server is misbehaving.
      for (let page = 0; page < 100; page += 1) {
        const result = await command('SCAN', cursor, 'MATCH', `${prefix}*`, 'COUNT', 200);
        if (!Array.isArray(result) || result.length < 2) break;
        const [next, batch] = result as [unknown, unknown];
        if (Array.isArray(batch)) {
          for (const key of batch) if (typeof key === 'string') found.add(key);
        }
        cursor = String(next);
        if (cursor === '0') break;
      }
      return [...found];
    },
  };
}

/**
 * An in-memory store, for tests and for `vite dev` with nothing attached.
 *
 * Not a fallback in production: a store that silently forgets on every cold start
 * would look like a working sessions screen and lose a session an hour later, which is
 * worse than saying plainly that no store is configured.
 */
export function memoryKv(initial: Record<string, string> = {}): KvStore {
  const map = new Map(Object.entries(initial));
  return {
    get: (key) => Promise.resolve(map.get(key) ?? null),
    set: (key, value) => {
      map.set(key, value);
      return Promise.resolve();
    },
    delete: (key) => Promise.resolve(map.delete(key)),
    keys: (prefix) => Promise.resolve([...map.keys()].filter((key) => key.startsWith(prefix))),
  };
}

/**
 * The configured store, or null when there is none.
 *
 * Null rather than a throw: "no store attached" is a legitimate deployment — stage one
 * of the build order is the extractor with an empty jar — and the settings screen needs
 * to explain it rather than fail.
 */
export function openKv(env: Record<string, string | undefined> = process.env): KvStore | null {
  const credentials = readKvCredentials(env);
  return credentials === null ? null : restKv(credentials);
}
