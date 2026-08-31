import { describe, expect, it } from 'vitest';
import { coerceHost } from '../src/lib/cookies.js';

describe('coerceHost', () => {
  it('accepts a bare host', () => {
    expect(coerceHost('www.nieuwsblad.be')).toBe('www.nieuwsblad.be');
    expect(coerceHost('  WWW.Nieuwsblad.BE.  ')).toBe('www.nieuwsblad.be');
  });

  // Pasting the article URL you were just looking at is the obvious thing to do.
  it('takes the host out of a URL', () => {
    expect(coerceHost('https://www.nieuwsblad.be/cnt/some-article')).toBe('www.nieuwsblad.be');
    expect(coerceHost('http://ft.com')).toBe('ft.com');
    expect(coerceHost('https://www.ft.com:443/x?y=1#z')).toBe('www.ft.com');
  });

  it('tolerates a host with a path or port stuck to it', () => {
    expect(coerceHost('www.ft.com/content/abc')).toBe('www.ft.com');
    expect(coerceHost('www.ft.com:8080')).toBe('www.ft.com');
  });

  // A typo stored as a key no request will ever match is worse than an error.
  it('rejects anything that is not a hostname', () => {
    expect(coerceHost('')).toBeNull();
    expect(coerceHost('   ')).toBeNull();
    expect(coerceHost('not a host')).toBeNull();
    expect(coerceHost('-leading-hyphen.com')).toBeNull();
    expect(coerceHost('double..dot.com')).toBeNull();
    expect(coerceHost('under_score.com')).toBeNull();
    expect(coerceHost('https://')).toBeNull();
  });

  // What a markdown-autolinked paste turns into.
  it('rejects a markdown link rather than storing it as a host', () => {
    expect(coerceHost('[www.nieuwsblad.be](https://www.nieuwsblad.be)')).toBeNull();
  });

  it('accepts IP literals', () => {
    expect(coerceHost('127.0.0.1')).toBe('127.0.0.1');
    expect(coerceHost('http://192.168.1.1/admin')).toBe('192.168.1.1');
  });

  it('strips control characters before judging', () => {
    expect(coerceHost('www.ft.com\n')).toBe('www.ft.com');
  });
});
