import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import { GET } from '../api/health';

describe('api/health', () => {
  it('answers 200 with ok:true', async () => {
    const res = GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it('is not cacheable', () => {
    expect(GET().headers.get('cache-control')).toBe('no-store');
  });

  it('leaks nothing about the deployment', async () => {
    // A health check reachable without a session must stay a liveness signal and
    // nothing more: no env var names, no versions, no Instapaper reachability.
    const body = await GET().text();
    expect(JSON.parse(body)).toEqual({ ok: true });
    expect(body).not.toMatch(/instapaper|token|version|stash_/i);
  });
});

/*
 * The SPA rewrite is a regex in vercel.json that nothing else would catch if it
 * regressed — a wrong pattern returns the app shell with 200 for a broken function
 * path, which surfaces much later as "JSON.parse got <!doctype html>".
 */
describe('vercel.json SPA rewrite', () => {
  const config = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8')) as {
    rewrites: Array<{ source: string; destination: string }>;
  };

  const fallback = config.rewrites.find((r) => r.destination === '/index.html');
  const matches = (path: string) => new RegExp(`^${fallback!.source}$`).test(path);

  it('exists', () => {
    expect(fallback).toBeDefined();
  });

  it('catches client-side routes', () => {
    for (const path of ['/', '/settings', '/unlock', '/read/12345', '/read/12345/anything']) {
      expect(matches(path), path).toBe(true);
    }
  });

  it('does not swallow function paths', () => {
    for (const path of ['/api/health', '/api/bookmarks', '/api/does-not-exist']) {
      expect(matches(path), path).toBe(false);
    }
  });
});
