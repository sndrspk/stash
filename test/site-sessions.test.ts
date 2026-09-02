import { beforeEach, describe, expect, it } from 'vitest';

import { cookieHeaderFor } from '../src/lib/cookies';
import { memoryKv, type KvStore } from '../src/lib/kv';
import { EncryptionKeyError, importKey, seal } from '../src/lib/secrets';
import {
  KEY_PREFIX,
  deleteSession,
  listSessions,
  loadJar,
  openSessionContext,
  saveSession,
  type SessionContext,
} from '../src/lib/site-sessions';

const KEY = 'a'.repeat(64);
const OTHER_KEY = 'b'.repeat(64);
const NOW = 1_700_000_000_000;

let kv: KvStore;
let context: SessionContext;

beforeEach(async () => {
  kv = memoryKv();
  context = { kv, key: await importKey(KEY) };
});

describe('saving a session', () => {
  it('keeps only name=value pairs', async () => {
    const saved = await saveSession(
      context,
      'www.ft.com',
      'FTSession=abc; FTUser=def; consent=1',
      () => NOW,
    );

    expect(saved).toEqual({
      host: 'www.ft.com',
      cookies: ['FTSession', 'FTUser', 'consent'],
      added: 3,
    });
  });

  it('accepts a header with the label and a stray newline, as pasted', async () => {
    const saved = await saveSession(context, 'www.ft.com', 'Cookie: a=1;\n b=2', () => NOW);
    expect(saved?.cookies).toEqual(['a', 'b']);
  });

  it('returns null for a paste with nothing usable in it', async () => {
    for (const junk of ['', '   ', 'https://www.ft.com/content/x', '{"a":1}']) {
      expect(await saveSession(context, 'www.ft.com', junk, () => NOW)).toBeNull();
    }
  });

  it('never wipes a stored session with an unusable paste', async () => {
    // Backing out of a paste must not destroy a session captured earlier. Clearing is
    // deleteSession, which is a button someone presses.
    await saveSession(context, 'www.ft.com', 'FTSession=abc', () => NOW);
    await saveSession(context, 'www.ft.com', 'nonsense', () => NOW);

    expect((await loadJar(context))['www.ft.com']).toBe('FTSession=abc');
  });

  it('merges, last wins per name', async () => {
    // A re-paste after an expiry usually carries the session cookies and not the
    // consent ones; replacing outright would quietly change what the publisher serves.
    await saveSession(context, 'www.ft.com', 'FTSession=old; consent=1', () => NOW);
    const merged = await saveSession(context, 'www.ft.com', 'FTSession=new', () => NOW + 1000);

    expect(merged?.cookies).toEqual(['FTSession', 'consent']);
    expect((await loadJar(context))['www.ft.com']).toBe('FTSession=new; consent=1');
  });
});

describe('what is written to the store', () => {
  it('is ciphertext — the header never appears in it', async () => {
    await saveSession(context, 'www.ft.com', 'FTSession=supersecretvalue', () => NOW);

    const blob = await kv.get(`${KEY_PREFIX}www.ft.com`);
    expect(blob).not.toBeNull();
    expect(blob).not.toContain('supersecretvalue');
    expect(blob).not.toContain('FTSession');
  });

  it('goes under its own namespace, apart from anything else', async () => {
    await saveSession(context, 'www.ft.com', 'a=1', () => NOW);
    expect(await kv.keys('')).toEqual([`${KEY_PREFIX}www.ft.com`]);
    expect(KEY_PREFIX).not.toMatch(/instapaper/i);
  });
});

describe('listing', () => {
  it('returns names and never values', async () => {
    await saveSession(context, 'www.ft.com', 'FTSession=abc; FTUser=def', () => NOW);
    await saveSession(context, 'www.nrc.nl', 'nrc=xyz', () => NOW);

    const listing = await listSessions(context);

    expect(listing.hosts.map((row) => row.host)).toEqual(['www.ft.com', 'www.nrc.nl']);
    expect(listing.hosts[0]?.cookies).toEqual(['FTSession', 'FTUser']);
    expect(listing.hosts[0]?.updatedAt).toBe(NOW);
    // The serialised listing is what reaches a browser; a value in it would be the
    // one leak this whole design exists to prevent.
    expect(JSON.stringify(listing)).not.toContain('abc');
    expect(JSON.stringify(listing)).not.toContain('xyz');
  });

  it('is empty, not broken, when nothing is stored', async () => {
    expect(await listSessions(context)).toEqual({ hosts: [], cleared: [] });
  });
});

describe('corrupt-blob recovery', () => {
  it('clears a blob sealed under a different key instead of crashing', async () => {
    // The key-rotation case. An exception here would take out the settings screen —
    // the one place a good value could be written from.
    const stale = await seal(
      JSON.stringify({ cookie: 'a=1', updated_at: NOW }),
      await importKey(OTHER_KEY),
    );
    await kv.set(`${KEY_PREFIX}www.ft.com`, stale);

    const listing = await listSessions(context);

    expect(listing.hosts).toEqual([]);
    expect(listing.cleared).toEqual(['www.ft.com']);
    expect(await kv.get(`${KEY_PREFIX}www.ft.com`)).toBeNull();
  });

  it('clears rubbish someone put in the store by hand', async () => {
    await kv.set(`${KEY_PREFIX}www.ft.com`, 'not a blob at all');
    expect((await listSessions(context)).cleared).toEqual(['www.ft.com']);
  });

  it('clears a blob that decrypts to something that is not a session', async () => {
    await kv.set(`${KEY_PREFIX}www.ft.com`, await seal('{"hello":"world"}', context.key));
    expect((await listSessions(context)).cleared).toEqual(['www.ft.com']);
  });

  it('recreates cleanly afterwards', async () => {
    await kv.set(`${KEY_PREFIX}www.ft.com`, 'rubbish');
    await saveSession(context, 'www.ft.com', 'FTSession=fresh', () => NOW);

    expect((await listSessions(context)).hosts[0]?.cookies).toEqual(['FTSession']);
    expect((await loadJar(context))['www.ft.com']).toBe('FTSession=fresh');
  });

  it('does not let one bad host hide the good ones', async () => {
    await saveSession(context, 'www.nrc.nl', 'nrc=1', () => NOW);
    await kv.set(`${KEY_PREFIX}www.ft.com`, 'rubbish');

    const listing = await listSessions(context);
    expect(listing.hosts.map((row) => row.host)).toEqual(['www.nrc.nl']);
    expect(listing.cleared).toEqual(['www.ft.com']);
  });
});

describe('deleting', () => {
  it('forgets one host and says whether there was one', async () => {
    await saveSession(context, 'www.ft.com', 'a=1', () => NOW);

    expect(await deleteSession(context, 'www.ft.com')).toBe(true);
    expect(await deleteSession(context, 'www.ft.com')).toBe(false);
    expect(await loadJar(context)).toEqual({});
  });

  it('leaves the other publishers alone', async () => {
    await saveSession(context, 'www.ft.com', 'a=1', () => NOW);
    await saveSession(context, 'www.nrc.nl', 'b=2', () => NOW);

    await deleteSession(context, 'www.ft.com');
    expect(Object.keys(await loadJar(context))).toEqual(['www.nrc.nl']);
  });
});

describe('the jar the extractor gets', () => {
  it('is the shape cookieHeaderFor takes, and matches by RFC 6265', async () => {
    await saveSession(context, 'nrc.nl', 'nrc=1', () => NOW);
    const jar = await loadJar(context);

    expect(cookieHeaderFor('https://www.nrc.nl/article', jar)).toBe('nrc=1');
    // The dot is the whole point: a session must not go to a lookalike host.
    expect(cookieHeaderFor('https://fakenrc.nl/article', jar)).toBeNull();
  });

  it('is empty when nothing is stored, which is the anonymous pass', async () => {
    expect(cookieHeaderFor('https://www.ft.com/x', await loadJar(context))).toBeNull();
  });
});

describe('openSessionContext', () => {
  it('is null when no store is attached', async () => {
    // A legitimate deployment: extraction with an empty jar is stage one of the design.
    expect(await openSessionContext({ STASH_ENCRYPTION_KEY: KEY })).toBeNull();
  });

  it('refuses a store with no encryption key', async () => {
    // The alternative would be writing plaintext session cookies to a third party.
    await expect(
      openSessionContext({ STASH_KV_URL: 'https://kv.example', STASH_KV_TOKEN: 't' }),
    ).rejects.toThrow(EncryptionKeyError);
  });

  it('opens when both are set', async () => {
    const opened = await openSessionContext({
      STASH_KV_URL: 'https://kv.example',
      STASH_KV_TOKEN: 't',
      STASH_ENCRYPTION_KEY: KEY,
    });
    expect(opened).not.toBeNull();
  });
});
