/**
 * Builds the xAuth token-exchange request.
 *
 * Split out of `scripts/connect.ts` so the wire format can be asserted in tests
 * rather than discovered against Instapaper. That is not hypothetical caution:
 * the first version of this request put the credentials in the `Authorization`
 * header with an empty body, and Instapaper answered `400 Bad Request` because
 * they never arrived where it reads them. Unit tests over the signing helpers all
 * passed — the shape of the request was what was wrong, so the shape is what is
 * pinned here.
 *
 * 400 versus 401 is the diagnostic worth remembering: 400 means the request was
 * malformed, 401 means it was understood and rejected. Only the second one is
 * about credentials or permissions.
 */
import { signRequest, type Param } from './oauth';

export const ACCESS_TOKEN_URL = 'https://www.instapaper.com/api/1/oauth/access_token';

export interface ExchangeRequest {
  url: string;
  method: 'POST';
  /** Named rather than a string index, so callers get the two that exist. */
  headers: { authorization: string; 'content-type': string };
  body: string;
}

export function buildExchangeRequest(options: {
  email: string;
  password: string;
  consumerKey: string;
  consumerSecret: string;
  nonce?: string;
  timestamp?: string;
}): ExchangeRequest {
  /*
   * The x_auth_* parameters are form-encoded body parameters. They participate in
   * the OAuth signature, as every form parameter does, but the Authorization
   * header carries only the oauth_* protocol parameters.
   *
   * Keeping the password out of the header matters for a second reason beyond
   * correctness: headers are what proxies and error reporters tend to log.
   */
  const credentials: Param[] = [
    ['x_auth_username', options.email],
    ['x_auth_password', options.password],
    ['x_auth_mode', 'client_auth'],
  ];

  const { header } = signRequest({
    method: 'POST',
    url: ACCESS_TOKEN_URL,
    consumerKey: options.consumerKey,
    consumerSecret: options.consumerSecret,
    body: credentials,
    nonce: options.nonce,
    timestamp: options.timestamp,
  });

  const form = new URLSearchParams();
  for (const [name, value] of credentials) form.append(name, value);

  return {
    url: ACCESS_TOKEN_URL,
    method: 'POST',
    headers: {
      authorization: header,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: form.toString(),
  };
}

/** The token pair, parsed from the form-encoded response body. */
export function parseExchangeResponse(body: string): { token: string; tokenSecret: string } | null {
  const parsed = new URLSearchParams(body);
  const token = parsed.get('oauth_token');
  const tokenSecret = parsed.get('oauth_token_secret');
  return token && tokenSecret ? { token, tokenSecret } : null;
}
