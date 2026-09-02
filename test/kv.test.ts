import { describe, expect, it } from 'vitest';

import { KvUnavailableError, memoryKv, readKvCredentials, restKv } from '../src/lib/kv';

describe('readKvCredentials', () => {
  it('finds the pair Vercel injects', () => {
    expect(
      readKvCredentials({ KV_REST_API_URL: 'https://kv.example', KV_REST_API_TOKEN: 't' }),
    ).toEqual({ url: 'https://kv.example', token: 't', source: 'KV_REST_API_URL' });
  });

  it('finds the pair Upstash gives you directly', () => {
    expect(
      readKvCredentials({
        UPSTASH_REDIS_REST_URL: 'https://up.example',
        UPSTASH_REDIS_REST_TOKEN: 't',
      })?.source,
    ).toBe('UPSTASH_REDIS_REST_URL');
  });

  it('lets STASH_KV_* win, so a project with two stores can say which', () => {
    expect(
      readKvCredentials({
        STASH_KV_URL: 'https://mine.example',
        STASH_KV_TOKEN: 'a',
        KV_REST_API_URL: 'https://other.example',
        KV_REST_API_TOKEN: 'b',
      })?.url,
    ).toBe('https://mine.example');
  });

  it('trims the trailing slash, since every command is posted to the root', () => {
    expect(
      readKvCredentials({ KV_REST_API_URL: 'https://kv.example/', KV_REST_API_TOKEN: 't' })?.url,
    ).toBe('https://kv.example');
  });

  it('is null when half a pair is set', () => {
    // Half a pair is a deployment mid-edit, and treating it as configured would give a
    // settings screen that fails on every request rather than saying nothing is attached.
    expect(readKvCredentials({ KV_REST_API_URL: 'https://kv.example' })).toBeNull();
    expect(readKvCredentials({ KV_REST_API_TOKEN: 't' })).toBeNull();
    expect(readKvCredentials({ KV_REST_API_URL: '  ', KV_REST_API_TOKEN: 't' })).toBeNull();
    expect(readKvCredentials({})).toBeNull();
  });
});

/** A Redis-over-HTTP server, recording the commands it was sent. */
function fakeServer(answer: (command: string[]) => unknown) {
  const commands: string[][] = [];
  const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
    const command = JSON.parse(String(init?.body)) as string[];
    commands.push(command);
    return new Response(JSON.stringify({ result: answer(command) }), { status: 200 });
  }) as unknown as typeof fetch;
  return { commands, fetchImpl };
}

const credentials = { url: 'https://kv.example', token: 'tok', source: 'STASH_KV_URL' };

describe('restKv', () => {
  it('sends the command as a JSON array with a bearer token', async () => {
    const { commands, fetchImpl } = fakeServer(() => 'value');
    const kv = restKv(credentials, fetchImpl);

    expect(await kv.get('k')).toBe('value');
    expect(commands).toEqual([['GET', 'k']]);
  });

  it('reads a missing key as null, not as the string "null"', async () => {
    const { fetchImpl } = fakeServer(() => null);
    expect(await restKv(credentials, fetchImpl).get('nope')).toBeNull();
  });

  it('reports whether a delete removed anything', async () => {
    const removed = fakeServer(() => 1);
    const absent = fakeServer(() => 0);
    expect(await restKv(credentials, removed.fetchImpl).delete('k')).toBe(true);
    expect(await restKv(credentials, absent.fetchImpl).delete('k')).toBe(false);
  });

  it('follows the SCAN cursor to the end', async () => {
    const pages: Record<string, [string, string[]]> = {
      '0': ['17', ['p:a', 'p:b']],
      '17': ['0', ['p:c']],
    };
    const { commands, fetchImpl } = fakeServer((command) => pages[command[1] ?? '']);

    expect((await restKv(credentials, fetchImpl).keys('p:')).sort()).toEqual(['p:a', 'p:b', 'p:c']);
    expect(commands).toHaveLength(2);
    expect(commands[0]).toContain('MATCH');
    expect(commands[0]).toContain('p:*');
  });

  it('stops rather than spinning when a server never returns cursor 0', async () => {
    // A bound, not a budget: reaching it means the server is misbehaving, and the one
    // thing this must not do is loop forever inside a request handler.
    const { commands, fetchImpl } = fakeServer(() => ['1', ['p:a']]);
    await restKv(credentials, fetchImpl).keys('p:');
    expect(commands.length).toBeLessThanOrEqual(100);
  });

  it('turns a non-2xx into KvUnavailableError without echoing the body', async () => {
    const fetchImpl = (() =>
      Promise.resolve(new Response('tok leaked?', { status: 500 }))) as unknown as typeof fetch;
    await expect(restKv(credentials, fetchImpl).get('k')).rejects.toThrow(KvUnavailableError);
    await expect(restKv(credentials, fetchImpl).get('k')).rejects.not.toThrow(/tok/);
  });

  it('surfaces an error field in a 200 body', async () => {
    const fetchImpl = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: 'WRONGTYPE' }), { status: 200 }),
      )) as unknown as typeof fetch;
    await expect(restKv(credentials, fetchImpl).get('k')).rejects.toThrow('WRONGTYPE');
  });
});

describe('memoryKv', () => {
  it('behaves like the real one', async () => {
    const kv = memoryKv({ 'p:a': '1' });

    expect(await kv.get('p:a')).toBe('1');
    expect(await kv.get('p:z')).toBeNull();

    await kv.set('p:b', '2');
    await kv.set('other', '3');
    expect((await kv.keys('p:')).sort()).toEqual(['p:a', 'p:b']);

    expect(await kv.delete('p:a')).toBe(true);
    expect(await kv.delete('p:a')).toBe(false);
  });
});
