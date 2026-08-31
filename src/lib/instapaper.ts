/**
 * The Instapaper Full API client.
 *
 * Every authenticated call in Stash goes through here, so the OAuth token exists
 * in exactly one place in the request path and the signing is done one way.
 *
 * Instapaper's API is form-encoded POSTs that return JSON, and it signals failure
 * in two different registers: HTTP status, and an error object inside a 200 body.
 * Both are normalised into one thrown `InstapaperError` so callers do not have to
 * remember which is which.
 */
import { signRequest, type Param } from './oauth';

export const INSTAPAPER_BASE = 'https://www.instapaper.com';

export interface InstapaperCredentials {
  consumerKey: string;
  consumerSecret: string;
  token: string;
  tokenSecret: string;
}

export class InstapaperError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Instapaper's own numeric code, when it sent one. */
    readonly code?: number,
  ) {
    super(message);
    this.name = 'InstapaperError';
  }
}

/**
 * A signed, form-encoded POST to an API path.
 *
 * The parameters are signed and sent as the body, which is what the API expects.
 * `params` is a list rather than an object because OAuth permits repeated names
 * and the signature depends on all of them.
 */
export async function call(
  path: string,
  params: readonly Param[],
  credentials: InstapaperCredentials,
  signal?: AbortSignal,
): Promise<unknown> {
  const url = `${INSTAPAPER_BASE}${path}`;

  const { header } = signRequest({
    method: 'POST',
    url,
    consumerKey: credentials.consumerKey,
    consumerSecret: credentials.consumerSecret,
    token: credentials.token,
    tokenSecret: credentials.tokenSecret,
    body: params,
  });

  const body = new URLSearchParams();
  for (const [name, value] of params) body.append(name, value);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      authorization: header,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: body.toString(),
    signal,
  });

  const text = await response.text();

  if (!response.ok) {
    // 401 here is the one worth naming: it is almost always a revoked token or a
    // consumer key without the permission the call needs, and the operator's fix
    // is to re-run `npm run connect` rather than to debug anything.
    throw new InstapaperError(
      response.status === 401
        ? 'Instapaper rejected the credentials (401). The token may be revoked — re-run `npm run connect`.'
        : `Instapaper returned HTTP ${response.status}`,
      response.status,
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new InstapaperError('Instapaper returned a body that was not JSON', response.status);
  }

  // A 200 can still carry an error object; the API reports most failures this way.
  if (Array.isArray(parsed)) {
    const error = parsed.find(
      (item): item is { type: string; error_code?: number; message?: string } =>
        typeof item === 'object' && item !== null && (item as { type?: unknown }).type === 'error',
    );
    if (error) {
      throw new InstapaperError(
        error.message ?? 'Instapaper reported an error',
        response.status,
        error.error_code,
      );
    }
  }

  return parsed;
}

/**
 * The cheapest authenticated call there is — used by `/settings` to answer "is this
 * deployment actually connected?" without pulling a bookmark list to find out.
 */
export async function verifyCredentials(
  credentials: InstapaperCredentials,
  signal?: AbortSignal,
): Promise<{ username?: string; userId?: number }> {
  const result = await call('/api/1.1/account/verify_credentials', [], credentials, signal);

  const user = Array.isArray(result)
    ? result.find(
        (item): item is Record<string, unknown> =>
          typeof item === 'object' && item !== null && (item as { type?: unknown }).type === 'user',
      )
    : undefined;

  return {
    username: typeof user?.username === 'string' ? user.username : undefined,
    userId: typeof user?.user_id === 'number' ? user.user_id : undefined,
  };
}

/** Reads the four Instapaper variables, throwing a ConfigError-shaped failure if any is missing. */
export function credentialsFromEnv(read: (name: string) => string): InstapaperCredentials {
  return {
    consumerKey: read('INSTAPAPER_CONSUMER_KEY'),
    consumerSecret: read('INSTAPAPER_CONSUMER_SECRET'),
    token: read('INSTAPAPER_OAUTH_TOKEN'),
    tokenSecret: read('INSTAPAPER_OAUTH_TOKEN_SECRET'),
  };
}
