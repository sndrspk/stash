import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  clearedSessionCookie,
  mintSession,
  readSessionCookie,
  sessionCookie,
  verifySession,
} from '../src/lib/session';

const PASS = 'correct horse battery staple';
const NOW = 1_700_000_000;

describe('mint and verify', () => {
  it('accepts a token it just minted', () => {
    expect(verifySession(mintSession(PASS, NOW), PASS, NOW)).toBe(true);
  });

  it('rejects a token minted under a different passphrase', () => {
    // The rotation property: changing STASH_PASSPHRASE invalidates every
    // outstanding cookie, with no store to purge.
    expect(verifySession(mintSession(PASS, NOW), 'a different passphrase', NOW)).toBe(false);
  });

  it('accepts right up to the expiry and rejects at it', () => {
    const token = mintSession(PASS, NOW);
    expect(verifySession(token, PASS, NOW + SESSION_TTL_SECONDS - 1)).toBe(true);
    expect(verifySession(token, PASS, NOW + SESSION_TTL_SECONDS)).toBe(false);
    expect(verifySession(token, PASS, NOW + SESSION_TTL_SECONDS + 99999)).toBe(false);
  });
});

describe('verify rejects tampering', () => {
  it('rejects a flipped payload', () => {
    const [payload, mac] = mintSession(PASS, NOW).split('.');
    // Re-encode a payload claiming a far-future expiry, keeping the original MAC.
    const forged = Buffer.from(JSON.stringify({ exp: NOW + 10 ** 9 })).toString('base64url');
    expect(forged).not.toBe(payload);
    expect(verifySession(`${forged}.${mac}`, PASS, NOW)).toBe(false);
  });

  it('rejects a flipped MAC', () => {
    const [payload] = mintSession(PASS, NOW).split('.');
    const wrong = Buffer.alloc(32, 7).toString('base64url');
    expect(verifySession(`${payload}.${wrong}`, PASS, NOW)).toBe(false);
  });

  it('rejects a truncated MAC rather than throwing', () => {
    // timingSafeEqual throws on a length mismatch; the length guard is what keeps
    // that from becoming an observable difference between failure modes.
    const token = mintSession(PASS, NOW);
    const short = token.slice(0, token.length - 6);
    expect(verifySession(short, PASS, NOW)).toBe(false);
  });

  it('rejects junk without throwing', () => {
    for (const bad of [
      undefined,
      '',
      '.',
      'a.',
      '.b',
      'nodot',
      'a.b.c',
      '!!!.???',
      'null.null',
      Buffer.from('{"exp":9999999999}').toString('base64url'),
    ]) {
      expect(() => verifySession(bad, PASS, NOW)).not.toThrow();
      expect(verifySession(bad, PASS, NOW)).toBe(false);
    }
  });

  it('rejects a payload that is valid JSON but not an object with exp', () => {
    // Reached only with a correct MAC, so mint each one properly first.
    for (const claims of ['"a string"', '42', 'null', '[]', '{}', '{"exp":"soon"}']) {
      const payload = Buffer.from(claims).toString('base64url');
      const key = createHmac('sha256', 'stash-session-v1').update(PASS).digest();
      const mac = createHmac('sha256', key).update(payload).digest('base64url');
      expect(verifySession(`${payload}.${mac}`, PASS, NOW)).toBe(false);
    }
  });
});

describe('cookie serialization', () => {
  it('sets every attribute the gate depends on', () => {
    const cookie = sessionCookie('tok');
    expect(cookie).toContain(`${SESSION_COOKIE}=tok`);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain(`Max-Age=${SESSION_TTL_SECONDS}`);
  });

  it('clears with a zero max-age', () => {
    expect(clearedSessionCookie()).toContain('Max-Age=0');
  });
});

describe('readSessionCookie', () => {
  it('finds the cookie among others', () => {
    expect(readSessionCookie(`other=1; ${SESSION_COOKIE}=wanted; third=3`)).toBe('wanted');
  });

  it('handles no surrounding spaces', () => {
    expect(readSessionCookie(`a=1;${SESSION_COOKIE}=wanted;b=2`)).toBe('wanted');
  });

  it('returns undefined when absent', () => {
    expect(readSessionCookie('other=1; third=3')).toBeUndefined();
    expect(readSessionCookie('')).toBeUndefined();
    expect(readSessionCookie(null)).toBeUndefined();
    expect(readSessionCookie(undefined)).toBeUndefined();
  });

  it('does not match a name that merely ends with ours', () => {
    // `evil_stash_session` must not be read as `stash_session`.
    expect(readSessionCookie(`evil_${SESSION_COOKIE}=attacker`)).toBeUndefined();
  });

  it('does not match a name that merely starts with ours', () => {
    expect(readSessionCookie(`${SESSION_COOKIE}_other=attacker`)).toBeUndefined();
  });

  it('keeps a value containing = intact', () => {
    expect(readSessionCookie(`${SESSION_COOKIE}=a.b==`)).toBe('a.b==');
  });
});
