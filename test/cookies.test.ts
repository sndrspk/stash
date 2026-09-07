import { describe, expect, it } from 'vitest';
import {
  cookieHeaderFor,
  cookieNames,
  domainMatches,
  mergeCookieHeaders,
  normalizeHost,
  parseCookieHeader,
  parseCookieInput,
  serializeCookies,
  widerHost,
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

describe('parseCookieInput', () => {
  it('recognises a real header', () => {
    const result = parseCookieInput('Cookie: a=1; b=2');
    expect(result.format).toBe('header');
    expect([...result.cookies.keys()]).toEqual(['a', 'b']);
  });

  it('reports empty stdin as its own case', () => {
    expect(parseCookieInput('').format).toBe('empty');
    expect(parseCookieInput('   \n ').format).toBe('empty');
  });

  // The paste people reach for first: DevTools → Application → Cookies → copy rows.
  it('recovers a tab-separated cookie table', () => {
    const table = [
      'name\tvalue\tdomain\tpath',
      'sessionid\tabc123\t.ft.com\t/',
      'uid\t42\t.ft.com\t/',
    ].join('\n');
    const result = parseCookieInput(table);
    expect(result.format).toBe('table');
    expect(result.cookies.get('sessionid')).toBe('abc123');
    expect(result.cookies.get('uid')).toBe('42');
    expect(result.cookies.has('name')).toBe(false); // the table's header row
  });

  it('does not mistake a table row containing = for one malformed cookie', () => {
    const result = parseCookieInput('sessionid\tabc=def\t.ft.com\t/');
    expect(result.format).toBe('table');
    expect(result.cookies.get('sessionid')).toBe('abc=def');
  });

  it('names the shape of an unusable paste without echoing it', () => {
    expect(parseCookieInput('https://www.ft.com/x').hint).toBe('a URL');
    expect(parseCookieInput('{"a":1}').hint).toBe('JSON');
    expect(parseCookieInput('just some prose here').hint).toMatch(/no "=" at all/);
  });

  it('never puts a cookie value in the hint', () => {
    const result = parseCookieInput('supersecretvalue with no pairs');
    expect(result.format).toBe('unrecognised');
    expect(result.hint).not.toContain('supersecret');
  });
});

/*
 * The suggestion the settings screen makes, and the reason it exists: the documented
 * way to fill the host field is to paste the article URL already on your clipboard,
 * which virtually always carries a `www` — so the convenient action stores the
 * narrower key. `domainMatches` is what makes that a real difference and not a
 * cosmetic one.
 */
describe('widerHost', () => {
  it('offers the apex for a www host', () => {
    expect(widerHost('www.nrc.nl')).toBe('nrc.nl');
    expect(widerHost('https://www.nrc.nl/nieuws/2026/01/01/iets')).toBe('nrc.nl');
  });

  it('offers nothing when there is nothing to widen', () => {
    expect(widerHost('nrc.nl')).toBeNull();
    expect(widerHost('')).toBeNull();
    expect(widerHost('not a host at all')).toBeNull();
  });

  it('leaves a real subdomain alone', () => {
    // `podcast.nrc.nl` may be exactly what the reader means, and widening it would be
    // guessing. `www` is the only prefix that is never a publisher's own choice.
    expect(widerHost('podcast.nrc.nl')).toBeNull();
    expect(widerHost('www2.nrc.nl')).toBeNull();
  });

  it('does not suggest a single-label host', () => {
    // `domainMatches` treats a single label as exact-only, so this would be a no-op
    // dressed up as an improvement.
    expect(widerHost('www.localhost')).toBeNull();
  });

  it('suggests something that genuinely matches more', () => {
    // The claim the button makes, asserted rather than described.
    const narrow = 'www.nrc.nl';
    const wide = widerHost(narrow);
    expect(wide).not.toBeNull();
    if (wide === null) return;

    for (const url of ['https://www.nrc.nl/a', 'https://nrc.nl/a', 'https://podcast.nrc.nl/a']) {
      expect(cookieHeaderFor(url, { [wide]: 'sid=1' })).toBe('sid=1');
    }
    expect(cookieHeaderFor('https://nrc.nl/a', { [narrow]: 'sid=1' })).toBeNull();
  });
});
