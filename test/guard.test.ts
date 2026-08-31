import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ConfigError, requireEnv, requireSession } from '../src/lib/guard';
import { SESSION_COOKIE, SESSION_TTL_SECONDS, mintSession } from '../src/lib/session';

const PASS = 'a long random deployment passphrase';
const NOW = 1_700_000_000;

const withCookie = (value: string) =>
  new Request('https://stash.example/api/status', { headers: { cookie: value } });

let saved: string | undefined;

beforeEach(() => {
  saved = process.env.STASH_PASSPHRASE;
  process.env.STASH_PASSPHRASE = PASS;
});

afterEach(() => {
  if (saved === undefined) delete process.env.STASH_PASSPHRASE;
  else process.env.STASH_PASSPHRASE = saved;
});

describe('requireEnv', () => {
  it('returns a set value', () => {
    expect(requireEnv('STASH_PASSPHRASE')).toBe(PASS);
  });

  it('throws ConfigError when unset', () => {
    delete process.env.STASH_PASSPHRASE;
    expect(() => requireEnv('STASH_PASSPHRASE')).toThrow(ConfigError);
  });

  it('treats an empty string as unset', () => {
    // An empty passphrase would otherwise compare equal to an empty submission.
    process.env.STASH_PASSPHRASE = '';
    expect(() => requireEnv('STASH_PASSPHRASE')).toThrow(ConfigError);
  });
});

describe('requireSession', () => {
  it('allows a valid session through', () => {
    const token = mintSession(PASS, NOW);
    expect(requireSession(withCookie(`${SESSION_COOKIE}=${token}`), NOW)).toBeUndefined();
  });

  it('refuses a request with no cookie at all', async () => {
    const refusal = requireSession(new Request('https://stash.example/api/status'), NOW);
    expect(refusal?.status).toBe(401);
    expect(await refusal?.json()).toEqual({ error: 'unauthorized' });
  });

  it('refuses an expired session', () => {
    const token = mintSession(PASS, NOW);
    const refusal = requireSession(
      withCookie(`${SESSION_COOKIE}=${token}`),
      NOW + SESSION_TTL_SECONDS + 1,
    );
    expect(refusal?.status).toBe(401);
  });

  it('refuses a session minted under a different passphrase', () => {
    const token = mintSession('some other passphrase', NOW);
    expect(requireSession(withCookie(`${SESSION_COOKIE}=${token}`), NOW)?.status).toBe(401);
  });

  it('refuses a forged cookie', () => {
    expect(requireSession(withCookie(`${SESSION_COOKIE}=not-a-token`), NOW)?.status).toBe(401);
  });

  it('refuses when another cookie is present but ours is not', () => {
    expect(requireSession(withCookie('unrelated=1; another=2'), NOW)?.status).toBe(401);
  });

  it('answers 503, not 401, when the deployment has no passphrase', async () => {
    // The distinction matters: a misconfigured deployment must never look like a
    // rejected credential, or the operator debugs the wrong thing — and must never
    // fall through to comparing against undefined.
    delete process.env.STASH_PASSPHRASE;
    const refusal = requireSession(new Request('https://stash.example/api/status'), NOW);
    expect(refusal?.status).toBe(503);
    expect(await refusal?.json()).toEqual({ error: 'not_configured' });
  });

  it('never leaks why it refused', async () => {
    const reasons = [
      new Request('https://stash.example/api/status'),
      withCookie(`${SESSION_COOKIE}=garbage`),
      withCookie(`${SESSION_COOKIE}=${mintSession('wrong', NOW)}`),
      withCookie(`${SESSION_COOKIE}=${mintSession(PASS, NOW - SESSION_TTL_SECONDS - 10)}`),
    ];
    const bodies = await Promise.all(reasons.map((r) => requireSession(r, NOW)!.text()));
    expect(new Set(bodies).size).toBe(1);
  });

  it('marks refusals as uncacheable', () => {
    const refusal = requireSession(new Request('https://stash.example/api/status'), NOW);
    expect(refusal?.headers.get('cache-control')).toBe('no-store');
  });
});
