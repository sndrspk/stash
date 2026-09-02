import { describe, expect, it } from 'vitest';

import { ApiError, apiErrorFrom, isTokenRejected } from '../src/lib/api-error';

const body = (value: unknown, status = 502) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('apiErrorFrom', () => {
  it('keeps our status and Instapaper\u2019s apart', async () => {
    /*
     * The distinction the whole diagnosis rests on: a revoked token is a 502 from our
     * own function wrapping a 401 from theirs, and only the inner number says which
     * of those it is.
     */
    const error = await apiErrorFrom(body({ error: 'instapaper', status: 401, detail: 'revoked' }));

    expect(error.status).toBe(502);
    expect(error.upstreamStatus).toBe(401);
    expect(error.code).toBe('instapaper');
    expect(error.message).toBe('revoked');
  });

  it('falls back to the code when there is no detail', async () => {
    expect((await apiErrorFrom(body({ error: 'timeout' }, 504))).message).toBe('timeout');
  });

  it('survives a body that is not JSON', async () => {
    // A crashed function returns HTML, and the status is still worth having.
    const error = await apiErrorFrom(new Response('<html>500</html>', { status: 500 }));
    expect(error.status).toBe(500);
    expect(error.message).toBe('Request failed with 500');
  });
});

describe('isTokenRejected', () => {
  it('is true only for Instapaper answering 401', () => {
    expect(isTokenRejected(new ApiError(502, 'x', 'instapaper', 401))).toBe(true);
  });

  it('is false for everything else', () => {
    // Our own 401 is the passphrase gate, which is re-entered on the unlock screen —
    // a different problem with a different fix.
    expect(isTokenRejected(new ApiError(401, 'unauthorized'))).toBe(false);
    // Instapaper having a bad afternoon.
    expect(isTokenRejected(new ApiError(502, 'x', 'instapaper', 503))).toBe(false);
    // A missing environment variable, which is the operator\u2019s problem but not this one.
    expect(isTokenRejected(new ApiError(503, 'x', 'not_configured'))).toBe(false);
    expect(isTokenRejected(new TypeError('Failed to fetch'))).toBe(false);
    expect(isTokenRejected(null)).toBe(false);
  });
});
