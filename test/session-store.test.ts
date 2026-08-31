import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  formatSessionText,
  loadSessionStore,
  parseSessionStore,
  parseSessionText,
  SessionStoreError,
} from '../src/lib/session-store.js';

describe('parseSessionText', () => {
  it('reads a whitespace-separated host and header', () => {
    expect(parseSessionText('www.ft.com FTSession=abc; FTUser=def')).toEqual({
      'www.ft.com': 'FTSession=abc; FTUser=def',
    });
  });

  it('accepts an = separator without eating the cookie’s own = signs', () => {
    expect(parseSessionText('www.ft.com = FTSession=abc; FTUser=def')).toEqual({
      'www.ft.com': 'FTSession=abc; FTUser=def',
    });
    expect(parseSessionText('www.ft.com=FTSession=abc')).toEqual({ 'www.ft.com': 'FTSession=abc' });
  });

  it('skips blank lines and comments', () => {
    const text = ['# a comment', '', '   ', 'a.test x=1', '# another', 'b.test y=2'].join('\n');
    expect(parseSessionText(text)).toEqual({ 'a.test': 'x=1', 'b.test': 'y=2' });
  });

  it('handles CRLF line endings', () => {
    expect(parseSessionText('a.test x=1\r\nb.test y=2\r\n')).toEqual({ 'a.test': 'x=1', 'b.test': 'y=2' });
  });

  it('ignores a host with no cookies rather than storing an empty session', () => {
    expect(parseSessionText('a.test\nb.test y=2')).toEqual({ 'b.test': 'y=2' });
  });

  // The whole reason this format exists: none of these break it.
  it('survives what JSON chokes on', () => {
    expect(parseSessionText(String.raw`a.test tok="quoted"; path=C:\x; b=1`)).toEqual({
      'a.test': String.raw`tok="quoted"; path=C:\x; b=1`,
    });
  });

  it('round-trips through formatSessionText', () => {
    const store = { 'b.test': 'y=2', 'a.test': 'x=1' };
    expect(parseSessionText(formatSessionText(store))).toEqual(store);
  });
});

describe('parseSessionStore', () => {
  it('parses JSON when the path says so', () => {
    expect(parseSessionStore('{"a.test":"x=1"}', 'sessions.json')).toEqual({ 'a.test': 'x=1' });
  });

  // The failure the JSON format actually produced in practice.
  it('explains itself when a pasted header has broken the JSON', () => {
    const broken = '{"a.test":"x=1\ny=2"}';
    expect(() => parseSessionStore(broken, 'sessions.json')).toThrow(SessionStoreError);
    expect(() => parseSessionStore(broken, 'sessions.json')).toThrow(/sessions\.txt/);
  });

  it('rejects a JSON array or a non-string value', () => {
    expect(() => parseSessionStore('[]', 'sessions.json')).toThrow(SessionStoreError);
    expect(() => parseSessionStore('{"a.test":42}', 'sessions.json')).toThrow(/must be a string/);
  });

  it('strips control characters that survived the file format', () => {
    const store = parseSessionStore('{"a.test":"x=1\\ty=2"}', 'sessions.json');
    expect(store['a.test']).toBe('x=1 y=2');
  });
});

describe('loadSessionStore', () => {
  const tmp = async (): Promise<string> => mkdtemp(join(tmpdir(), 'stash-store-'));

  it('returns an empty store when nothing exists', async () => {
    const dir = await tmp();
    const loaded = await loadSessionStore(join(dir, 'sessions.txt'));
    expect(loaded).toEqual({ store: {}, path: null, problems: [] });
  });

  // The deadlock this replaced: a corrupt store blocked the command that would fix it.
  it('reports an unreadable store as a problem rather than throwing', async () => {
    const dir = await tmp();
    const path = join(dir, 'sessions.json');
    await writeFile(path, '{"a.test":"x=1\ny=2"}', 'utf8');

    const loaded = await loadSessionStore(path);
    expect(loaded.store).toEqual({});
    expect(loaded.path).toBeNull();
    expect(loaded.problems).toHaveLength(1);
    expect(loaded.problems[0]).toMatch(/not valid JSON/);
  });

  it('reads a good store with no problems', async () => {
    const dir = await tmp();
    const path = join(dir, 'sessions.txt');
    await writeFile(path, 'a.test x=1\n', 'utf8');

    const loaded = await loadSessionStore(path);
    expect(loaded.store).toEqual({ 'a.test': 'x=1' });
    expect(loaded.path).toBe(path);
    expect(loaded.problems).toEqual([]);
  });
});
