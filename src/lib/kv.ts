/**
 * The key-value binding.
 *
 * Stash has no database and does not want one. There is one user and one access
 * pattern — *give me the cookies for this host* — so the store is a dictionary, and a
 * relational table would be two columns that are never joined, sorted or queried.
 * It cannot be an environment variable either, the way the Instapaper token is: sessions
 * are added and replaced while the app is running.
 *
 * There are two transports, because managed Redis comes in two shapes and a reader who
 * has already attached one should not have to attach a different one.
 *
 * **Redis over HTTP** (`restKv`) is the preferred one and stays dependency-free. Vercel
 * KV and Upstash both speak it — a POST whose JSON body is the command as an array — so
 * a client is thirty lines of `fetch`, it is stateless, and a serverless invocation that
 * makes one request and exits fits it exactly.
 *
 * **Redis over TCP** (`tcpKv`) exists because most managed Redis is only that: Redis
 * Cloud, ElastiCache and a plain self-hosted server all hand you a `redis://` URL and no
 * HTTP endpoint at all. Before this, such a deployment reported that no store was
 * attached while a perfectly good one sat there. It costs a dependency — `ioredis`,
 * rather than a hand-rolled RESP client, because this connection carries the reader's
 * publisher credentials and protocol parsing, TLS and AUTH are not places to be
 * inventive — and it costs a connection to manage, which `connectionFor` explains.
 *
 * Both are `KvStore`, so nothing above this file knows which one it has. Cloudflare KV
 * is a third shape; when that matters it is a third implementation and still nothing
 * above changes.
 *
 * What is stored here is ciphertext (`lib/secrets.ts`) under keys this module never
 * interprets. The namespacing rule from the spec lives one layer up in
 * `lib/site-sessions.ts` and is the reason `keys()` takes a prefix at all.
 */
import Redis from 'ioredis';

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

/**
 * The connection-string variables, for the TCP transport.
 *
 * `STASH_REDIS_URL` is first for the same reason `STASH_KV_URL` is: a deployment with
 * more than one store attached needs a way to say which one Stash uses. The rest are
 * what providers inject on their own — `REDIS_URL` is close to universal, and Vercel
 * has used `KV_URL` for the TCP half of a store whose HTTP half is `KV_REST_API_URL`.
 */
const CONNECTION_STRING_VARS = [
  'STASH_REDIS_URL',
  'REDIS_URL',
  'KV_URL',
  'UPSTASH_REDIS_URL',
] as const;

const isSet = (value: string | undefined): boolean => value !== undefined && value.trim() !== '';

/**
 * Why no store was found, in terms of variable names.
 *
 * `readKvCredentials` returns null for several quite different deployments, and the
 * settings screen was reporting all of them with one sentence that named none. That is
 * the failure `docs/VERCEL.md` already records costing an hour: a message that
 * describes the symptom while the process holds the cause.
 *
 * It once explained a `redis://` connection string as the reason nothing was attached.
 * That sentence is gone with the transport that made it true — a connection string is
 * now a working store, so a deployment with one never reaches this function. A
 * diagnostic that outlives the fault it describes sends the next reader to check
 * something that is already correct, which is the same hour again.
 *
 * **Names only, never values.** This is behind the passphrase gate, but a token has
 * no reason to be in a rendered string, and the rule is easier to keep than to audit.
 */
export function describeKvEnv(env: Record<string, string | undefined> = process.env): string {
  const halves: string[] = [];
  for (const [urlVar, tokenVar] of ENV_PAIRS) {
    if (isSet(env[urlVar]) && !isSet(env[tokenVar])) {
      halves.push(`${urlVar} is set but ${tokenVar} is not`);
    }
    if (isSet(env[tokenVar]) && !isSet(env[urlVar])) {
      halves.push(`${tokenVar} is set but ${urlVar} is not`);
    }
  }

  const parts: string[] = [];
  if (halves.length > 0) {
    parts.push(`${halves.join('; ')}. Both halves of one pair are needed.`);
  }
  parts.push(
    'A store is either an HTTP pair — STASH_KV_URL/STASH_KV_TOKEN, ' +
      'KV_REST_API_URL/KV_REST_API_TOKEN or UPSTASH_REDIS_REST_URL/UPSTASH_REDIS_REST_TOKEN — ' +
      'or a connection string in STASH_REDIS_URL, REDIS_URL, KV_URL or UPSTASH_REDIS_URL. ' +
      'None of them reached this function.',
  );

  // True in every one of the cases above, and the two things that most often explain
  // a variable that exists in the dashboard but not in the running function.
  parts.push(
    'If you have just added them, redeploy — the environment is attached at build time, ' +
      'so an existing deployment keeps the set it was built with. And check the scope: a ' +
      'variable set for Production is absent from a preview URL.',
  );

  return parts.join(' ');
}

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
 * The slice of a Redis client this module uses. Four commands, and the reason the
 * store can be tested against a real server *and* against a stub without either
 * pretending to be the other.
 */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
  del(key: string): Promise<number>;
  scan(
    cursor: string,
    matchToken: 'MATCH',
    pattern: string,
    countToken: 'COUNT',
    count: number,
  ): Promise<[string, string[]]>;
}

/**
 * A store over a TCP Redis connection.
 *
 * Deliberately the same shape as `restKv`, including the SCAN loop and its bound: the
 * two transports must not drift into answering `keys()` differently, because the
 * settings screen renders whichever one it got.
 *
 * Every failure becomes `KvUnavailableError` with the client's own message. A dropped
 * connection, a wrong password and a refused TLS handshake are all "the store is not
 * usable right now", and the caller above handles them identically — but the message is
 * kept rather than replaced, because "ECONNREFUSED" names the fault and "could not
 * reach the store" asserts one.
 */
export function tcpKv(client: RedisLike): KvStore {
  async function guard<T>(what: string, run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new KvUnavailableError(`${what} failed: ${detail}`);
    }
  }

  return {
    get: (key) => guard('GET', async () => (await client.get(key)) ?? null),

    set: (key, value) =>
      guard('SET', async () => {
        await client.set(key, value);
      }),

    delete: (key) => guard('DEL', async () => (await client.del(key)) > 0),

    keys: (prefix) =>
      guard('SCAN', async () => {
        const found = new Set<string>();
        let cursor = '0';
        // The same hundred-page bound as the HTTP transport, and for the same reason:
        // reaching it means the server is misbehaving, not that the store is large.
        for (let page = 0; page < 100; page += 1) {
          const [next, batch] = await client.scan(cursor, 'MATCH', `${prefix}*`, 'COUNT', 200);
          for (const key of batch) found.add(key);
          cursor = String(next);
          if (cursor === '0') break;
        }
        return [...found];
      }),
  };
}

/**
 * One connection per URL, kept for the life of the process.
 *
 * This is the part a serverless runtime makes awkward, and the cost the HTTP transport
 * does not have. A function invocation is short and the container is frozen between
 * them, so connecting per request would put a TCP and TLS handshake in front of every
 * read; connecting per module load and never reusing it would leak a socket per cold
 * start. Caching by URL is the middle: a warm container reuses its connection, a cold
 * one pays the handshake once.
 *
 * The options are the ones that stop a frozen-then-thawed connection from becoming a
 * hung request. `lazyConnect` keeps a module import from opening a socket — importing
 * this file must stay free, since `describeKvEnv` and the tests do it. `commandTimeout`
 * is what turns a connection that died while the container slept into an error the
 * settings screen can render, rather than a spinner that never resolves.
 */
const connections = new Map<string, RedisLike>();

/**
 * How many TCP connections this process has opened.
 *
 * Exported for one assertion and nothing else: that resolving a deployment which has
 * both transports does not open a socket it will never use. That is invisible from the
 * outside — the store returned works either way — and it is the whole reason HTTP is
 * preferred, so it is worth being able to state.
 */
export const connectionCount = (): number => connections.size;

export function connectionFor(url: string): RedisLike {
  const existing = connections.get(url);
  if (existing !== undefined) return existing;

  const client = new Redis(url, {
    lazyConnect: true,
    connectTimeout: 5_000,
    commandTimeout: 5_000,
    maxRetriesPerRequest: 2,
    // Three attempts and then give up, rather than ioredis's default of retrying
    // forever: a function that cannot reach its store should say so and exit, not hold
    // the invocation open until the platform kills it.
    retryStrategy: (times: number) => (times > 3 ? null : Math.min(times * 200, 1_000)),
  });

  /*
   * An 'error' event with no listener is an unhandled exception in Node, and ioredis
   * emits one for every failed reconnection attempt. The command itself already
   * rejects — that is what the caller sees — so this exists only to stop a background
   * retry from taking down the function with an error the request path has handled.
   */
  client.on('error', () => {});

  connections.set(url, client);
  return client;
}

/** The first connection string a deployment has set, or null. */
export function readRedisUrl(
  env: Record<string, string | undefined>,
): { url: string; source: string } | null {
  for (const name of CONNECTION_STRING_VARS) {
    const url = env[name]?.trim();
    if (url !== undefined && url !== '') return { url, source: name };
  }
  return null;
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
  /*
   * HTTP wins when a deployment has both, and that is not arbitrary: it is stateless,
   * so it has no connection to go stale while the container is frozen and no handshake
   * on a cold start. A deployment with both attached is usually one Upstash store
   * offering two ways in, and the cheaper way in is the right default.
   */
  const credentials = readKvCredentials(env);
  if (credentials !== null) return restKv(credentials);

  const connection = readRedisUrl(env);
  if (connection !== null) return tcpKv(connectionFor(connection.url));

  return null;
}
