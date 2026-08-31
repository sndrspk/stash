import { describe, expect, it } from 'vitest';
import {
  cookieHeaderFor,
  cookieNames,
  domainMatches,
  mergeCookieHeaders,
  normalizeHost,
  parseCookieHeader,
  serializeCookies,
} from '../src/lib/cookies.js';

describe('domainMatches', () => {
  it('matches a host against itself', () => {
    expect(domainMatches('nytimes.com', 'nytimes.com')).toBe(true);
  });

  it('lets an apex cookie reach subdomains', () => {
    expect(domainMatches('www.nytimes.com', 'nytimes.com')).toBe(true);
    expect(domainMatches('a.b.nytimes.com', 'nytimes.com')).toBe(true);
  });

  it('does not let a subdomain cookie climb', () => {
    expect(domainMatches('nytimes.com', 'www.nytimes.com')).toBe(false);
  });

  // The reason the leading dot exists. A bare endsWith passes every one of these.
  it('rejects spoofed suffixes', () => {
    expect(domainMatches('fakenytimes.com', 'nytimes.com')).toBe(false);
    expect(domainMatches('evil-nytimes.com', 'nytimes.com')).toBe(false);
    expect(domainMatches('xnytimes.com', 'nytimes.com')).toBe(false);
  });

  it('rejects a saved host used as a mere substring', () => {
    expect(domainMatches('nytimes.com.evil.test', 'nytimes.com')).toBe(false);
    expect(domainMatches('evil.test', 'nytimes.com')).toBe(false);
  });

  it('is case-insensitive and tolerates leading and trailing dots', () => {
    expect(domainMatches('WWW.NYTimes.COM', '.nytimes.com')).toBe(true);
    expect(domainMatches('www.nytimes.com.', 'nytimes.com')).toBe(true);
    expect(domainMatches('  www.nytimes.com  ', '  .NYTIMES.com  ')).toBe(true);
  });

  it('never matches on an empty host', () => {
    expect(domainMatches('', 'nytimes.com')).toBe(false);
    expect(domainMatches('nytimes.com', '')).toBe(false);
    expect(domainMatches('nytimes.com', '.')).toBe(false);
    expect(domainMatches('', '')).toBe(false);
  });

  it('will not let a single-label host claim a whole TLD', () => {
    expect(domainMatches('nytimes.com', 'com')).toBe(false);
    expect(domainMatches('localhost', 'localhost')).toBe(true);
    expect(domainMatches('evil.localhost', 'localhost')).toBe(false);
  });

  it('matches IP literals exactly and never by suffix', () => {
    expect(domainMatches('1.2.3.4', '1.2.3.4')).toBe(true);
    expect(domainMatches('11.2.3.4', '1.2.3.4')).toBe(false);
    expect(domainMatches('192.168.1.1', '168.1.1')).toBe(false);
    expect(domainMatches('[::1]', '::1')).toBe(false);
  });
});

describe('parseCookieHeader', () => {
  it('splits name=value pairs', () => {
    expect([...parseCookieHeader('a=1; b=2')]).toEqual([
      ['a', '1'],
      ['b', '2'],
    ]);
  });

  it('splits on the first = only, so values may contain =', () => {
    expect(parseCookieHeader('token=abc=def==').get('token')).toBe('abc=def==');
  });

  it('strips a pasted "Cookie:" label', () => {
    expect(parseCookieHeader('Cookie: a=1; b=2').get('a')).toBe('1');
    expect(parseCookieHeader('cookie:a=1').get('a')).toBe('1');
  });

  it('tolerates ragged whitespace and trailing separators', () => {
    expect([...parseCookieHeader('  a = 1 ;;  b=2;  ')]).toEqual([
      ['a', '1'],
      ['b', '2'],
    ]);
  });

  it('keeps empty values but drops nameless pairs', () => {
    expect(parseCookieHeader('a=; =2; b=3').get('a')).toBe('');
    expect(parseCookieHeader('a=; =2; b=3').has('')).toBe(false);
    expect(parseCookieHeader('novalue').size).toBe(0);
  });

  it('is last-wins on a repeated name', () => {
    expect(parseCookieHeader('a=1; a=2').get('a')).toBe('2');
  });

  it('round-trips through serializeCookies', () => {
    const header = 'session=xyz; uid=42';
    expect(serializeCookies(parseCookieHeader(header))).toBe(header);
  });
});

describe('mergeCookieHeaders', () => {
  it('adds new names and overwrites existing ones', () => {
    expect(mergeCookieHeaders('a=1; b=2', 'b=9; c=3')).toBe('a=1; b=9; c=3');
  });

  // Backing out of a sign-in must not destroy a session captured earlier.
  it('treats a blank incoming value as a no-op, not a wipe', () => {
    expect(mergeCookieHeaders('a=1', '')).toBe('a=1');
    expect(mergeCookieHeaders('a=1', '   ')).toBe('a=1');
    expect(mergeCookieHeaders('a=1', 'Cookie:')).toBe('a=1');
  });
});

describe('cookieHeaderFor', () => {
  const store = {
    'nytimes.com': 'apex=1',
    'cooking.nytimes.com': 'sub=1',
    'ft.com': '',
  };

  it('returns the matching host’s header', () => {
    expect(cookieHeaderFor('https://www.nytimes.com/x', store)).toBe('apex=1');
  });

  it('prefers the most specific matching host', () => {
    expect(cookieHeaderFor('https://cooking.nytimes.com/r/1', store)).toBe('sub=1');
  });

  it('returns null for an unknown host, a blank entry, or a bad URL', () => {
    expect(cookieHeaderFor('https://example.com/', store)).toBeNull();
    expect(cookieHeaderFor('https://ft.com/', store)).toBeNull();
    expect(cookieHeaderFor('not a url', store)).toBeNull();
  });
});

describe('cookieNames', () => {
  it('exposes names without ever exposing values', () => {
    const names = cookieNames('session=supersecret; uid=42');
    expect(names).toEqual(['session', 'uid']);
    expect(names.join()).not.toContain('supersecret');
  });
});

describe('normalizeHost', () => {
  it('lowercases and strips surrounding dots and whitespace', () => {
    expect(normalizeHost('  .Example.COM. ')).toBe('example.com');
  });
});
