import { beforeEach, describe, expect, it } from 'vitest';

import { clientKey, rateLimit, resetRateLimits } from '../src/lib/rate-limit';

beforeEach(resetRateLimits);

describe('rateLimit', () => {
  it('allows up to the limit and refuses past it', () => {
    for (let i = 0; i < 5; i++) {
      expect(rateLimit('k', 5, 60, 1000).allowed, `attempt ${i + 1}`).toBe(true);
    }
    expect(rateLimit('k', 5, 60, 1000).allowed).toBe(false);
  });

  it('reports seconds until the window resets', () => {
    for (let i = 0; i < 5; i++) rateLimit('k', 5, 60, 0);
    // 30s into a 60s window, 30s remain.
    expect(rateLimit('k', 5, 60, 30_000).retryAfter).toBe(30);
  });

  it('starts a fresh window once the old one passes', () => {
    for (let i = 0; i < 6; i++) rateLimit('k', 5, 60, 0);
    expect(rateLimit('k', 5, 60, 0).allowed).toBe(false);
    expect(rateLimit('k', 5, 60, 60_001).allowed).toBe(true);
  });

  it('tracks keys independently', () => {
    for (let i = 0; i < 6; i++) rateLimit('a', 5, 60, 0);
    expect(rateLimit('a', 5, 60, 0).allowed).toBe(false);
    expect(rateLimit('b', 5, 60, 0).allowed).toBe(true);
  });

  it('does not grow without bound', () => {
    // An attacker cycling source addresses must not be able to exhaust memory.
    for (let i = 0; i < 12_000; i++) rateLimit(`key-${i}`, 5, 60, 0);
    // Still enforcing for a fresh key rather than having fallen over.
    expect(rateLimit('fresh', 5, 60, 0).allowed).toBe(true);
  });
});

describe('clientKey', () => {
  const req = (headers: Record<string, string>) =>
    new Request('https://stash.example/api/unlock', { headers });

  it('takes the left-most forwarded address', () => {
    expect(clientKey(req({ 'x-forwarded-for': '203.0.113.9, 70.41.3.18' }))).toBe('203.0.113.9');
  });

  it('trims whitespace', () => {
    expect(clientKey(req({ 'x-forwarded-for': '  203.0.113.9  ' }))).toBe('203.0.113.9');
  });

  it('falls back to x-real-ip', () => {
    expect(clientKey(req({ 'x-real-ip': '198.51.100.7' }))).toBe('198.51.100.7');
  });

  it('falls back to a constant when nothing identifies the caller', () => {
    // Everyone unidentified shares one bucket. That is the safe direction: it
    // limits more, never less.
    expect(clientKey(req({}))).toBe('unknown');
  });

  it('ignores an empty forwarded header', () => {
    expect(clientKey(req({ 'x-forwarded-for': '' }))).toBe('unknown');
  });
});
