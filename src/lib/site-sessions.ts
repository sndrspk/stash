/**
 * Publisher sessions, as they live on the server.
 *
 * This is `sessions.txt` from `SESSIONS.md`, hosted and encrypted: a host maps to a
 * `Cookie:` header value, and that value is a bearer credential for the reader's
 * subscription. Three rules from `docs/EXTRACTION.md` are enforced here rather than
 * anywhere else, because here is the only place they can be:
 *
 * - **Never in the browser.** The client sends a host and a header in; it can read back
 *   the host list and the cookie *names*. `listSessions` is the only accessor a
 *   request handler is meant to use, and it cannot return a value.
 * - **Encrypted at rest under our own key**, so the storage provider holds ciphertext.
 * - **Kept apart from the app's own credentials.** The Instapaper token is an
 *   environment variable and is not in this store at all; the namespace below exists so
 *   that stays true even if something else is added later. Rotating one must never
 *   destroy the other — re-acquiring site sessions means walking through every
 *   publisher again.
 *
 * The deliberate lossiness is inherited from the CLI: only `name=value` survives.
 * `Secure`, `HttpOnly`, `Path`, `Expires` and `SameSite` are dropped, because every
 * target is TLS, the cookies sit at the root, and expiry is the publisher's to enforce.
 */
import {
  cookieNames,
  mergeCookieHeaders,
  parseCookieInput,
  serializeCookies,
  type SessionStore,
} from './cookies.js';
import { openKv, type KvStore } from './kv.js';
import { CorruptBlobError, EncryptionKeyError, importKey, open, seal } from './secrets.js';

/**
 * Every key this app writes starts here.
 *
 * The version segment is what makes a format change survivable: a `v2` record can sit
 * beside a `v1` one while they are migrated, and `keys()` on the `v1` prefix still
 * finds exactly the old ones.
 */
export const KEY_PREFIX = 'stash:site-session:v1:';

const keyFor = (host: string) => `${KEY_PREFIX}${host}`;
const hostFrom = (key: string) => key.slice(KEY_PREFIX.length);

/** What is sealed. Nothing outside the blob names a host's cookies. */
interface StoredSession {
  cookie: string;
  updated_at: number;
}

export interface SessionContext {
  kv: KvStore;
  key: CryptoKey;
}

/** One host, as the client is allowed to see it: names, never values. */
export interface SessionSummary {
  host: string;
  /** Cookie names only. A value never leaves this module. */
  cookies: string[];
  updatedAt: number;
}

export interface SessionListing {
  hosts: SessionSummary[];
  /**
   * Hosts whose blob could not be decrypted and has been removed.
   *
   * Surfaced rather than swallowed: a session that silently vanished after a key
   * rotation looks like a bug in the extractor, and the fix — paste it again — is only
   * obvious to someone who has been told.
   */
  cleared: string[];
}

/**
 * The store and the key, or null when no store is attached.
 *
 * Null is a legitimate deployment: stage one of the build order is the extractor with
 * an empty jar, which needs no store at all. A store *with* no encryption key is not
 * legitimate — it would mean writing plaintext credentials to a third party — so that
 * throws.
 */
export async function openSessionContext(
  env: Record<string, string | undefined> = process.env,
): Promise<SessionContext | null> {
  const kv = openKv(env);
  if (kv === null) return null;

  const material = env.STASH_ENCRYPTION_KEY;
  if (material === undefined || material.trim() === '') {
    throw new EncryptionKeyError(
      'A key-value store is attached but STASH_ENCRYPTION_KEY is not set. Session cookies are never written unencrypted.',
    );
  }
  return { kv, key: await importKey(material) };
}

/**
 * Read one host's record, deleting it if it will not decrypt.
 *
 * SanFeedBin's corrupt-blob recovery, and the reason it is recovery rather than a
 * throw: the value is unrecoverable either way, and an exception here would take out
 * the settings screen — the one place from which a good value could be written.
 */
async function readRecord(
  context: SessionContext,
  host: string,
): Promise<{ record: StoredSession | null; cleared: boolean }> {
  const blob = await context.kv.get(keyFor(host));
  if (blob === null) return { record: null, cleared: false };

  let plain: string;
  try {
    plain = await open(blob, context.key);
  } catch (error) {
    if (error instanceof CorruptBlobError) {
      await context.kv.delete(keyFor(host));
      return { record: null, cleared: true };
    }
    throw error;
  }

  try {
    const parsed = JSON.parse(plain) as Partial<StoredSession>;
    if (typeof parsed.cookie !== 'string' || parsed.cookie.trim() === '') {
      await context.kv.delete(keyFor(host));
      return { record: null, cleared: true };
    }
    return {
      record: {
        cookie: parsed.cookie,
        updated_at: typeof parsed.updated_at === 'number' ? parsed.updated_at : 0,
      },
      cleared: false,
    };
  } catch {
    // Decrypted cleanly but is not our JSON: same recovery, same reasoning.
    await context.kv.delete(keyFor(host));
    return { record: null, cleared: true };
  }
}

/** The hosts that have a session, with cookie names and nothing else. */
export async function listSessions(context: SessionContext): Promise<SessionListing> {
  const keys = await context.kv.keys(KEY_PREFIX);
  const hosts: SessionSummary[] = [];
  const cleared: string[] = [];

  for (const key of keys.sort()) {
    const host = hostFrom(key);
    if (host === '') continue;
    const { record, cleared: gone } = await readRecord(context, host);
    if (gone) cleared.push(host);
    else if (record !== null) {
      hosts.push({ host, cookies: cookieNames(record.cookie), updatedAt: record.updated_at });
    }
  }

  return { hosts, cleared };
}

export interface SaveResult {
  host: string;
  /** Names of every cookie now stored for the host, merged. */
  cookies: string[];
  /** How many of those names arrived in this paste. */
  added: number;
}

/**
 * Store a pasted header for a host.
 *
 * Merged rather than replaced, last-wins per name, exactly as the CLI does it: a
 * re-paste after a session expires usually carries the session cookies and not the
 * consent and preference ones, and dropping those would quietly change what the
 * publisher serves. A paste with no usable pairs is refused by the caller, never
 * treated as a wipe — clearing is `deleteSession`, which is a deliberate act.
 */
export async function saveSession(
  context: SessionContext,
  host: string,
  rawHeader: string,
  now: () => number = Date.now,
): Promise<SaveResult | null> {
  const parsed = parseCookieInput(rawHeader);
  if (parsed.cookies.size === 0) return null;

  const incoming = serializeCookies(parsed.cookies);
  const { record } = await readRecord(context, host);
  const merged = record === null ? incoming : mergeCookieHeaders(record.cookie, incoming);

  const payload: StoredSession = { cookie: merged, updated_at: now() };
  await context.kv.set(keyFor(host), await seal(JSON.stringify(payload), context.key));

  return { host, cookies: cookieNames(merged), added: parsed.cookies.size };
}

/** Forget one host. True when there was something to forget. */
export function deleteSession(context: SessionContext, host: string): Promise<boolean> {
  return context.kv.delete(keyFor(host));
}

/**
 * Every stored session, as the flat host → header map the cookie jar takes.
 *
 * The one function that returns cookie *values*, and the one no request handler calls:
 * it exists for `api/extract`, which hands the result straight to `cookieHeaderFor` and
 * never puts it in a response. Kept separate from `listSessions` so that "which
 * function can leak a credential" has a one-word answer.
 */
export async function loadJar(context: SessionContext): Promise<SessionStore> {
  const keys = await context.kv.keys(KEY_PREFIX);
  const store: SessionStore = {};

  for (const key of keys) {
    const host = hostFrom(key);
    if (host === '') continue;
    const { record } = await readRecord(context, host);
    if (record !== null) store[host] = record.cookie;
  }

  return store;
}
