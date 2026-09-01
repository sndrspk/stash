/**
 * Reading `/api/status`'s answer, including the answers that are not statuses.
 *
 * This lives outside the component so it can be asserted directly. The bug it
 * exists to prevent was a type assertion: `/settings` fetched the endpoint and cast
 * whatever came back to `Status`, checking only for 401. A refusal from the guard is
 * `{ error: 'not_configured' }` with a 503, and casting that produces an object
 * whose every field is undefined — which renders as "Not connected. Could not reach
 * Instapaper." with no detail.
 *
 * So a deployment with no `STASH_PASSPHRASE`, refusing every call before a line of
 * Instapaper code ran, described itself as an Instapaper connectivity problem. Sync
 * read the same body's `error` field and said `not_configured`. One cause, two
 * unrelated-sounding messages, neither naming it.
 */

export interface Status {
  connected: boolean;
  username?: string;
  reason?: 'not_configured' | 'rejected' | 'timeout' | 'error' | 'refused';
  detail?: string;
}

/** An expired session is the gate's business, not an error to display. */
export const TO_UNLOCK = 'unlock';

export type StatusView = Status | typeof TO_UNLOCK;

/**
 * Turns an HTTP status and a parsed body into what the screen should show.
 *
 * Note the two `not_configured` answers, which share a code and mean different
 * things: a **503 from the guard** means `STASH_PASSPHRASE` is unset and nothing
 * reached Instapaper, while a **200 from the handler** means the gate passed and an
 * `INSTAPAPER_*` variable is unset. Reading the first as the second sends the
 * operator to check credentials that were never consulted.
 */
export function classifyStatusResponse(httpStatus: number, body: unknown): StatusView {
  if (httpStatus === 401) return TO_UNLOCK;

  if (httpStatus < 200 || httpStatus >= 300) {
    const error = (body as { error?: string } | null)?.error;
    return {
      connected: false,
      reason: 'refused',
      detail: `/api/status answered ${httpStatus}${error ? ` — ${error}` : ''}`,
    };
  }

  return body as Status;
}
