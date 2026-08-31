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
 * regressed, and it has two distinct failure modes.
 *
 * Too greedy and it swallows things that are not client routes. In production that
 * is mostly hidden, because Vercel checks the filesystem before applying rewrites —
 * but `vercel dev` applies them *before* proxying to the Vite dev server, where the
 * module graph is served from memory rather than disk. An earlier version of this
 * pattern rewrote `/src/main.tsx` and `/@vite/client` to `/index.html`, so Vite was
 * handed HTML and tried to parse it as JavaScript. Local development simply did not
 * start.
 *
 * Too narrow and deep links 404 instead of reaching the router.
 *
 * The rule that satisfies both: a client route has no file extension and does not
 * begin with `@`. Every asset and every dev-server module has one or the other.
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
    for (const path of ['/api/health', '/api/unlock', '/api/status', '/api/does-not-exist']) {
      expect(matches(path), path).toBe(false);
    }
  });

  it('does not swallow Vite dev-server module requests', () => {
    // The regression that broke `vercel dev`. These are served from the dev
    // server's memory, so no filesystem check protects them.
    for (const path of [
      '/src/main.tsx',
      '/src/routes/Unlock.tsx',
      '/@vite/client',
      '/@react-refresh',
      '/node_modules/.vite/deps/react.js',
      '/src/styles/theme.css',
    ]) {
      expect(matches(path), path).toBe(false);
    }
  });

  it('does not swallow built assets', () => {
    for (const path of [
      '/assets/index-DklecbVi.js',
      '/assets/index-abc123.css',
      '/fonts/geist-latin.woff2',
      '/icons/icon-512.png',
      '/manifest.webmanifest',
      '/sw.js',
      '/registerSW.js',
    ]) {
      expect(matches(path), path).toBe(false);
    }
  });
});
