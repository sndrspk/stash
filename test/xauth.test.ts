import { describe, expect, it } from 'vitest';

import { ACCESS_TOKEN_URL, buildExchangeRequest, parseExchangeResponse } from '../src/lib/xauth';

/*
 * Regression coverage for a bug the signing tests could not catch.
 *
 * Every unit test over `src/lib/oauth.ts` passed while `connect` was sending its
 * credentials in the Authorization header with an empty body. The helpers were
 * right; the request built out of them was not. Instapaper answered 400 — not the
 * 401 we had prepared a whole diagnostic message for — because the parameters
 * never reached where it reads them.
 *
 * So these assert the wire format itself: what is in the body, what is in the
 * header, and what must never be in either.
 */
const fixed = {
  email: 'reader@example.com',
  password: 'a password with spaces & symbols=',
  consumerKey: 'ck',
  consumerSecret: 'cs',
  nonce: 'fixed-nonce',
  timestamp: '1700000000',
};

describe('buildExchangeRequest', () => {
  const request = buildExchangeRequest(fixed);
  const bodyParams = new URLSearchParams(request.body);

  it('POSTs form-encoded to the access_token endpoint', () => {
    expect(request.url).toBe(ACCESS_TOKEN_URL);
    expect(request.method).toBe('POST');
    expect(request.headers['content-type']).toBe('application/x-www-form-urlencoded');
  });

  it('carries all three x_auth parameters in the body', () => {
    expect(bodyParams.get('x_auth_username')).toBe(fixed.email);
    expect(bodyParams.get('x_auth_password')).toBe(fixed.password);
    expect(bodyParams.get('x_auth_mode')).toBe('client_auth');
  });

  it('round-trips a password containing form-significant characters', () => {
    // '&' and '=' would split the body if it were concatenated by hand.
    expect(bodyParams.get('x_auth_password')).toBe('a password with spaces & symbols=');
  });

  it('puts no x_auth parameter in the Authorization header', () => {
    expect(request.headers.authorization).not.toContain('x_auth');
  });

  it('never puts the password in the header', () => {
    // Headers are what proxies and error reporters log.
    expect(request.headers.authorization).not.toContain('password');
    expect(request.headers.authorization).not.toContain(fixed.password);
    expect(request.headers.authorization).not.toContain(encodeURIComponent(fixed.password));
  });

  it('sends only oauth_* parameters in the header', () => {
    const header = request.headers.authorization;
    expect(header.startsWith('OAuth ')).toBe(true);
    for (const pair of header.slice('OAuth '.length).split(', ')) {
      expect(pair.startsWith('oauth_'), `unexpected header parameter: ${pair}`).toBe(true);
    }
  });

  it('carries no oauth_token, since that is what it is asking for', () => {
    expect(request.headers.authorization).not.toContain('oauth_token=');
  });

  it('signs the body parameters', () => {
    // Change only the password; the signature must change with it. This is what
    // proves the body took part in the signature rather than merely riding along.
    const other = buildExchangeRequest({ ...fixed, password: 'different' });
    expect(other.headers.authorization).not.toBe(request.headers.authorization);
  });

  it('is deterministic for a fixed nonce and timestamp', () => {
    expect(buildExchangeRequest(fixed).headers.authorization).toBe(request.headers.authorization);
  });
});

describe('parseExchangeResponse', () => {
  it('reads the token pair from a form-encoded body', () => {
    expect(parseExchangeResponse('oauth_token=abc&oauth_token_secret=xyz')).toEqual({
      token: 'abc',
      tokenSecret: 'xyz',
    });
  });

  it('returns null when either half is missing', () => {
    expect(parseExchangeResponse('oauth_token=abc')).toBeNull();
    expect(parseExchangeResponse('oauth_token_secret=xyz')).toBeNull();
    expect(parseExchangeResponse('')).toBeNull();
  });

  it('returns null for a body that is not form-encoded at all', () => {
    // An HTML error page parses without throwing and yields nothing, which is the
    // behaviour we want: a clear "no token" rather than an exception.
    expect(parseExchangeResponse('<html><title>400</title></html>')).toBeNull();
  });
});
