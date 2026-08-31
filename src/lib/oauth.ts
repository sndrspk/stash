/**
 * OAuth 1.0a request signing (HMAC-SHA1), per RFC 5849.
 *
 * Instapaper's Full API is OAuth 1.0a, so every authenticated call — the one-time
 * xAuth token exchange in `scripts/connect.ts` and every serverless function after
 * it — signs through here.
 *
 * The whole protocol reduces to building one string exactly right. Almost every
 * OAuth 1.0a bug is in that construction rather than in the crypto: percent-encoding
 * that trusts `encodeURIComponent`, parameters sorted before encoding instead of
 * after, a duplicated key ordered by chance, a port left on the base URI. All of
 * them fail identically at the server — `401`, no detail — which is why this module
 * is tested against the RFC's own worked example before it is ever pointed at
 * Instapaper. When the exchange then 401s, the signing is not the suspect.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * RFC 3986 percent-encoding, which is *not* what `encodeURIComponent` does: it
 * leaves `!`, `'`, `(`, `)` and `*` unescaped. Unreserved is exactly
 * `ALPHA / DIGIT / "-" / "." / "_" / "~"` and everything else is encoded.
 */
export function percentEncode(value: string): string {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
  );
}

/** One request parameter. A name may legitimately repeat (RFC 5849 §3.4.1.3.2). */
export type Param = readonly [name: string, value: string];

/**
 * Normalizes parameters into the single string the base string embeds.
 *
 * Order matters and is easy to get subtly wrong: sort by the *encoded* name, and
 * where names tie, by the *encoded* value. Sorting the raw strings gives a
 * different order whenever encoding changes the byte sequence, and the result
 * still looks plausible.
 */
export function normalizeParameters(params: readonly Param[]): string {
  return params
    .map(([name, value]) => [percentEncode(name), percentEncode(value)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([name, value]) => `${name}=${value}`)
    .join('&');
}

/**
 * The base URI: scheme and host lowercased, default ports dropped, query and
 * fragment removed. Those parameters are not lost — they belong in the parameter
 * string instead, which `signRequest` handles.
 */
export function baseStringUri(url: string): string {
  const u = new URL(url);
  const scheme = u.protocol.slice(0, -1).toLowerCase();
  const host = u.hostname.toLowerCase();
  const isDefaultPort =
    !u.port || (scheme === 'http' && u.port === '80') || (scheme === 'https' && u.port === '443');
  return `${scheme}://${host}${isDefaultPort ? '' : ':' + u.port}${u.pathname}`;
}

/** METHOD & base-URI & normalized-parameters, each component percent-encoded. */
export function signatureBaseString(method: string, url: string, params: readonly Param[]): string {
  return [
    method.toUpperCase(),
    percentEncode(baseStringUri(url)),
    percentEncode(normalizeParameters(params)),
  ].join('&');
}

/**
 * The signing key is the two secrets, each encoded, joined by `&` — and the
 * separator is always present, even when there is no token secret yet, which is
 * exactly the case during the xAuth exchange.
 */
export function signingKey(consumerSecret: string, tokenSecret = ''): string {
  return `${percentEncode(consumerSecret)}&${percentEncode(tokenSecret)}`;
}

export function hmacSha1(baseString: string, key: string): string {
  return createHmac('sha1', key).update(baseString).digest('base64');
}

export interface SignOptions {
  method: string;
  /** Full URL. Any query string on it is folded into the signature automatically. */
  url: string;
  consumerKey: string;
  consumerSecret: string;
  /** Absent during the xAuth exchange, present for every call after it. */
  token?: string;
  tokenSecret?: string;
  /**
   * Form-encoded body parameters. These are signed alongside the query, but they
   * travel in the request body — **including xAuth's `x_auth_*`**.
   *
   * There is deliberately no option for "sign it and also put it in the header".
   * OAuth 1.0a's `Authorization` header carries protocol parameters only, and an
   * earlier version of this module offered such an escape hatch, which is exactly
   * how `connect` came to send its credentials in the header with an empty body.
   * Instapaper answered 400 — the parameters simply were not where it looks.
   */
  body?: readonly Param[];
  /** Injectable so tests are deterministic; generated per request otherwise. */
  nonce?: string;
  timestamp?: string;
}

export interface SignedRequest {
  /** The value for the `Authorization` header. */
  header: string;
  /** Exposed for tests and for diagnosing a rejected signature. */
  baseString: string;
  signature: string;
}

/**
 * Signs a request and returns the `Authorization` header value.
 *
 * `oauth_signature` is computed over everything else and then added; it is never
 * part of its own base string. `realm`, had we one, would be sent in the header
 * but likewise excluded.
 */
export function signRequest(options: SignOptions): SignedRequest {
  const nonce = options.nonce ?? randomBytes(16).toString('hex');
  const timestamp = options.timestamp ?? Math.floor(Date.now() / 1000).toString();

  const oauthParams: Param[] = [
    ['oauth_consumer_key', options.consumerKey],
    ['oauth_nonce', nonce],
    ['oauth_signature_method', 'HMAC-SHA1'],
    ['oauth_timestamp', timestamp],
    ['oauth_version', '1.0'],
  ];
  if (options.token) oauthParams.push(['oauth_token', options.token]);

  const query: Param[] = [...new URL(options.url).searchParams].map(([k, v]) => [k, v] as Param);

  const baseString = signatureBaseString(options.method, options.url, [
    ...oauthParams,
    ...query,
    ...(options.body ?? []),
  ]);

  const signature = hmacSha1(baseString, signingKey(options.consumerSecret, options.tokenSecret));

  // Only protocol parameters go in the header. Body and query parameters were
  // signed, but they travel in the body and query where they belong — the caller
  // is responsible for actually sending them there.
  const headerParams: Param[] = [...oauthParams, ['oauth_signature', signature]];

  const header =
    'OAuth ' +
    headerParams
      .map(([name, value]) => `${percentEncode(name)}="${percentEncode(value)}"`)
      .join(', ');

  return { header, baseString, signature };
}

/**
 * Constant-time string comparison, for anything an attacker can guess repeatedly.
 *
 * `timingSafeEqual` throws on a length mismatch, which would leak the length via
 * the exception — so both sides are hashed to a fixed width first and the digests
 * compared instead.
 */
export function secretsMatch(a: string, b: string): boolean {
  const ha = createHmac('sha256', 'stash-compare').update(a).digest();
  const hb = createHmac('sha256', 'stash-compare').update(b).digest();
  return timingSafeEqual(ha, hb);
}
