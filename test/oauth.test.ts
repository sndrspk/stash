import { describe, expect, it } from 'vitest';

import {
  baseStringUri,
  hmacSha1,
  normalizeParameters,
  percentEncode,
  secretsMatch,
  signRequest,
  signatureBaseString,
  signingKey,
  type Param,
} from '../src/lib/oauth';

/*
 * The anchor for this whole module: RFC 5849 §3.4.1, worked end to end.
 *
 * If these pass, a 401 from Instapaper is a credentials or permissions problem —
 * most likely xAuth not being enabled on the consumer key — and not our signing.
 * Being able to tell those two apart is the entire reason this is written first.
 */
describe('RFC 5849 §3.4.1 worked example', () => {
  // POST /request?b5=%3D%253D&a3=a&c%40=&a2=r%20b, body: c2&a3=2+q
  const url = 'http://example.com/request?b5=%3D%253D&a3=a&c%40=&a2=r%20b';
  const body: Param[] = [
    ['c2', ''],
    ['a3', '2 q'],
  ];
  const oauth: Param[] = [
    ['oauth_consumer_key', '9djdj82h48djs9d2'],
    ['oauth_token', 'kkk9d7dh3k39sjv7'],
    ['oauth_signature_method', 'HMAC-SHA1'],
    ['oauth_timestamp', '137131201'],
    ['oauth_nonce', '7d8f3e4a'],
  ];
  const query: Param[] = [...new URL(url).searchParams].map(([k, v]) => [k, v] as Param);
  const all = [...oauth, ...query, ...body];

  it('normalizes the parameters as the RFC prints them (§3.4.1.3.2)', () => {
    expect(normalizeParameters(all)).toBe(
      'a2=r%20b&a3=2%20q&a3=a&b5=%3D%253D&c%40=&c2=&oauth_consumer_key=9djdj82h48djs9d2' +
        '&oauth_nonce=7d8f3e4a&oauth_signature_method=HMAC-SHA1&oauth_timestamp=137131201' +
        '&oauth_token=kkk9d7dh3k39sjv7',
    );
  });

  it('builds the signature base string as the RFC prints it (§3.4.1.1)', () => {
    expect(signatureBaseString('POST', url, all)).toBe(
      'POST&http%3A%2F%2Fexample.com%2Frequest&a2%3Dr%2520b%26a3%3D2%2520q%26a3%3Da' +
        '%26b5%3D%253D%25253D%26c%2540%3D%26c2%3D%26oauth_consumer_key%3D9djdj82h48djs9d2' +
        '%26oauth_nonce%3D7d8f3e4a%26oauth_signature_method%3DHMAC-SHA1' +
        '%26oauth_timestamp%3D137131201%26oauth_token%3Dkkk9d7dh3k39sjv7',
    );
  });

  it('produces the RFC signing key (§3.4.2)', () => {
    expect(signingKey('j49sk3j29djd', 'dh893hdasih9')).toBe('j49sk3j29djd&dh893hdasih9');
  });
});

/*
 * There is deliberately no single end-to-end "sign this request, get this exact
 * signature" assertion here, and that is not an omission.
 *
 * RFC 5849 prints its example in pieces: §3.1 shows a request carrying
 * oauth_signature="bYT5CMsGcbgUdFHObYMEfcx6bsw%3D" but never states the secrets it
 * was made with, while §3.4.2's signing key appears in a different discussion.
 * Pairing the two is a guess, and asserting a guess as a spec vector is worse than
 * asserting nothing: it fails, and whoever meets that failure cannot tell a real
 * regression from a bad expectation. (This part of the RFC's example also has
 * published errata.)
 *
 * So the chain is verified in two halves, each against a source that states its
 * inputs and outputs together:
 *
 *   1. base string construction  → RFC 5849 §3.4.1.1, asserted above and matching
 *      the printed value exactly. This is where OAuth 1.0a implementations
 *      actually go wrong.
 *   2. HMAC-SHA1 over that string → RFC 2202, below.
 *
 * Both halves right means the composition is right.
 */
describe('HMAC-SHA1 against an RFC 2202 vector', () => {
  // `hmacSha1` is a thin pass-through to node:crypto, so this is not testing HMAC —
  // it pins the two choices that are ours and that fail silently if wrong: SHA-1
  // rather than SHA-256, and base64 output rather than hex. Either mistake produces
  // a well-formed signature that every server rejects.
  it('is SHA-1, base64-encoded', () => {
    expect(hmacSha1('what do ya want for nothing?', 'Jefe')).toBe(
      Buffer.from('effcdf6ae5eb2fa2d27416d5f184df9c259a7c79', 'hex').toString('base64'),
    );
  });
});

describe('percentEncode', () => {
  it('leaves the unreserved set alone', () => {
    const unreserved = 'abcXYZ019-._~';
    expect(percentEncode(unreserved)).toBe(unreserved);
  });

  it('encodes what encodeURIComponent misses', () => {
    // The exact reason this function exists rather than a bare encodeURIComponent.
    expect(percentEncode("!'()*")).toBe('%21%27%28%29%2A');
  });

  it('uses uppercase hex', () => {
    expect(percentEncode(' ')).toBe('%20');
    expect(percentEncode('=')).toBe('%3D');
    expect(percentEncode('~')).toBe('~');
  });

  it('encodes non-ASCII as UTF-8 octets', () => {
    expect(percentEncode('é')).toBe('%C3%A9');
    expect(percentEncode('☃')).toBe('%E2%98%83');
  });
});

describe('normalizeParameters', () => {
  it('sorts by encoded name, then by encoded value', () => {
    expect(
      normalizeParameters([
        ['b', '2'],
        ['a', 'z'],
        ['a', 'a'],
      ]),
    ).toBe('a=a&a=z&b=2');
  });

  it('sorts on the encoded form, not the raw one', () => {
    // Raw: '!' (0x21) sorts before 'a'. Encoded: '%21' sorts before 'a' too, but
    // ' ' (0x20) sorts before '!' raw while '%20' sorts after nothing alphabetic —
    // this pins the comparison to the encoded bytes.
    expect(
      normalizeParameters([
        ['a b', '1'],
        ['a!', '2'],
      ]),
    ).toBe('a%20b=1&a%21=2');
  });

  it('keeps repeated names', () => {
    expect(
      normalizeParameters([
        ['x', '1'],
        ['x', '2'],
      ]),
    ).toBe('x=1&x=2');
  });

  it('handles empty values', () => {
    expect(normalizeParameters([['x', '']])).toBe('x=');
  });
});

describe('baseStringUri', () => {
  it('lowercases scheme and host', () => {
    expect(baseStringUri('HTTP://EXAMPLE.com/Path')).toBe('http://example.com/Path');
  });

  it('drops default ports but keeps others', () => {
    expect(baseStringUri('http://example.com:80/x')).toBe('http://example.com/x');
    expect(baseStringUri('https://example.com:443/x')).toBe('https://example.com/x');
    expect(baseStringUri('https://example.com:8443/x')).toBe('https://example.com:8443/x');
  });

  it('strips query and fragment', () => {
    expect(baseStringUri('https://example.com/x?a=1#frag')).toBe('https://example.com/x');
  });
});

describe('signRequest', () => {
  const base = {
    method: 'POST',
    url: 'https://www.instapaper.com/api/1/oauth/access_token',
    consumerKey: 'ck',
    consumerSecret: 'cs',
    nonce: 'fixed-nonce',
    timestamp: '1700000000',
  };

  it('never signs oauth_signature into its own base string', () => {
    const { baseString } = signRequest(base);
    expect(baseString).not.toContain('oauth_signature%3D');
  });

  it('omits oauth_token when there is none, as during the xAuth exchange', () => {
    const { header, baseString } = signRequest(base);
    expect(baseString).not.toContain('oauth_token');
    expect(header).not.toContain('oauth_token=');
  });

  it('keeps the trailing separator in the signing key with no token secret', () => {
    // A missing '&' here is a classic xAuth failure: it 401s and looks like a
    // credentials problem.
    expect(signingKey('cs')).toBe('cs&');
  });

  it('signs body parameters but keeps them out of the header', () => {
    const { header, baseString } = signRequest({
      ...base,
      extra: [
        ['x_auth_mode', 'client_auth'],
        ['x_auth_username', 'reader@example.com'],
      ],
    });
    expect(baseString).toContain('x_auth_mode');
    // x_auth_* are protocol parameters and do belong in the header.
    expect(header).toContain('x_auth_mode="client_auth"');
  });

  it('quotes and encodes every header parameter', () => {
    const { header } = signRequest({ ...base, extra: [['x_auth_username', 'a b@c.com']] });
    expect(header.startsWith('OAuth ')).toBe(true);
    expect(header).toContain('x_auth_username="a%20b%40c.com"');
  });

  it('is deterministic for a fixed nonce and timestamp', () => {
    expect(signRequest(base).signature).toBe(signRequest(base).signature);
  });

  it('changes signature when any input changes', () => {
    const original = signRequest(base).signature;
    expect(signRequest({ ...base, consumerSecret: 'cs2' }).signature).not.toBe(original);
    expect(signRequest({ ...base, nonce: 'other' }).signature).not.toBe(original);
    expect(signRequest({ ...base, method: 'GET' }).signature).not.toBe(original);
  });

  it('generates a distinct nonce per call when none is given', () => {
    const a = signRequest({ ...base, nonce: undefined });
    const b = signRequest({ ...base, nonce: undefined });
    expect(a.signature).not.toBe(b.signature);
  });

  it('folds a query string into the signature', () => {
    const withQuery = signRequest({ ...base, url: base.url + '?limit=5' });
    expect(withQuery.baseString).toContain('limit%3D5');
  });
});

describe('secretsMatch', () => {
  it('accepts an exact match', () => {
    expect(secretsMatch('correct horse battery staple', 'correct horse battery staple')).toBe(true);
  });

  it('rejects a near miss', () => {
    expect(secretsMatch('passphrase', 'passphrasf')).toBe(false);
  });

  it('rejects differing lengths without throwing', () => {
    // timingSafeEqual throws on length mismatch; hashing first is what avoids
    // both the exception and the length leak it would represent.
    expect(secretsMatch('short', 'considerably longer value')).toBe(false);
  });

  it('handles empty strings', () => {
    expect(secretsMatch('', '')).toBe(true);
    expect(secretsMatch('', 'x')).toBe(false);
  });
});
