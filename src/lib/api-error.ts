/**
 * A non-2xx from one of our own functions.
 *
 * It lives in its own module rather than beside the hooks that throw it because the
 * image pass needs to recognise a 401 without dragging TanStack Query — and a
 * dependency cycle — into a file that only talks to IndexedDB and `fetch`.
 */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail?: string,
    /** The body's `error` field: `not_configured`, `instapaper`, `timeout`, … */
    readonly code?: string,
    /**
     * The status **Instapaper** answered with, when the failure came from there.
     *
     * Distinct from `status`, which is our own function's, and the distinction is the
     * point: a revoked token is a 502 from us wrapping a 401 from them, and only the
     * inner number says which of those it is.
     */
    readonly upstreamStatus?: number,
  ) {
    super(detail ?? `Request failed with ${status}`);
    this.name = 'ApiError';
  }
}

/**
 * Read one of our functions' error bodies into an `ApiError`.
 *
 * One place, because every function answers in the same shape and every caller was
 * otherwise picking a different subset of it out by hand.
 */
export async function apiErrorFrom(response: Response): Promise<ApiError> {
  let body: { detail?: string; error?: string; status?: number } = {};
  try {
    body = (await response.json()) as typeof body;
  } catch {
    // A non-JSON error body is itself informative — a crashed function returns HTML —
    // but there is nothing useful to pull out of it.
  }
  return new ApiError(response.status, body.detail ?? body.error, body.error, body.status);
}

/**
 * Whether Instapaper refused our stored credentials.
 *
 * The one failure the reader can actually do something about, and the one that must
 * never be retried: the token is revoked or the consumer key lacks a permission, and
 * both are fixed by running `npm run connect` again rather than by waiting. Every
 * function wraps it the same way — a 502 from us carrying Instapaper's own 401 — so
 * asking here is asking once.
 */
export function isTokenRejected(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'instapaper' && error.upstreamStatus === 401;
}
