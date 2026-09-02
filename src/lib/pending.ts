/**
 * Replaying archive and delete actions that have not reached Instapaper yet.
 *
 * The queue exists because the local mark and the remote call are two separate things
 * and a phone on a train does the first and not the second. Without one, the choices
 * are both bad: refuse the action while offline, or accept it and lose it.
 *
 * Three rules shape everything here, and all three come from the same place — these
 * calls reach a real Instapaper account, and delete is irreversible there.
 *
 * - **One article, one intent.** Enforced by the store's key, not by this file. A
 *   reader who archives and then deletes has changed their mind, not queued two jobs.
 * - **Serial, and one call per article.** There is no batch endpoint anywhere in
 *   Stash and this does not invent one by looping quickly: the flush is sequential,
 *   the same shape a reader clicking would produce.
 * - **A failure is either transient or permanent, and the difference decides
 *   everything.** Transient keeps the intent and retries later. Permanent puts the
 *   article back, because replaying it will never work and an article silently
 *   missing from the queue is worse than one that reappears.
 */
import { ApiError, apiErrorFrom, isTokenRejected } from './api-error.js';
import { clearPending, noteError, readPending, recordAttempt, unmarkPurge } from './store.js';

/**
 * How many *answered* failures before an action is given up on.
 *
 * A stop for an action that fails consistently for a reason this code cannot
 * classify: without it, an article stuck in the queue asks Instapaper the same
 * unanswerable question on every app start, forever.
 *
 * **A request that never reached the server does not count against it**, and that
 * distinction is the whole reason `unreachable` exists below. The first version
 * counted every failure, and the browser run showed what that costs: five attempts
 * were spent inside one offline session — a flush fires on app start, on `online`,
 * and on every queued action — so a reader archiving a handful of articles on a train
 * could watch them reappear, reverted for exceeding a retry budget while the network
 * was never there to answer. Being offline is not evidence about an action.
 */
export const MAX_ATTEMPTS = 5;

export interface FlushResult {
  /** Reached Instapaper and are done. */
  sent: number;
  /** Failed in a way worth retrying; still queued. */
  deferred: number;
  /** Failed permanently. The article has been put back and the intent dropped. */
  reverted: number;
  /** True if the gate has lapsed — the caller sends the reader to /unlock. */
  unauthorized: boolean;
  /**
   * True if Instapaper refused the stored token.
   *
   * Reported separately from `unauthorized` because the fix is different and lives
   * somewhere else: the passphrase gate is re-entered on the unlock screen, while a
   * revoked Instapaper token is re-issued by running `npm run connect` on a machine
   * this app has no access to. Telling a reader to unlock when the token is the
   * problem sends them round a loop that cannot end.
   */
  tokenRejected: boolean;
}

export interface FlushOptions {
  /** Seam for tests. Resolves for success, throws `ApiError` or a network error. */
  send?: (action: 'archive' | 'delete', id: number) => Promise<void>;
}

async function post(action: 'archive' | 'delete', id: number): Promise<void> {
  const response = await fetch(`/api/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ bookmark_id: id }),
  });
  if (response.ok) return;
  throw await apiErrorFrom(response);
}

/**
 * What a failure means, in the only three categories that lead anywhere different.
 *
 * - `unreachable` — the request never completed, so the server said nothing at all.
 *   Keep the intent, and **do not count it**: silence is not an answer about this
 *   action, it is an answer about the network.
 * - `retry` — the server answered, and the answer might be different next time.
 *   Keep the intent and count the attempt.
 * - `permanent` — the server answered that this request is wrong and always will be.
 *   Put the article back; replaying cannot help.
 *
 * The conservative direction between the last two is `retry`: keeping a doomed intent
 * costs a handful of requests and then hits `MAX_ATTEMPTS`, while dropping a good one
 * loses the reader's decision silently.
 */
export type FailureKind = 'unreachable' | 'retry' | 'permanent';

export function classify(error: unknown): FailureKind {
  /*
   * Anything that is not an `ApiError` never got a response. `fetch` rejects with a
   * `TypeError` for offline, DNS failure and connection reset alike — and by the time
   * it has rejected there is no status to read, which is exactly the point.
   */
  if (!(error instanceof ApiError)) return 'unreachable';

  // 400: the id is malformed and re-sending it cannot help.
  // 404: the endpoint is not there — a deployment mismatch, not a network blip.
  // 410: gone.
  if (error.status === 400 || error.status === 404 || error.status === 410) return 'permanent';
  return 'retry';
}

/**
 * A 401 stops the flush rather than failing one action.
 *
 * The gate has lapsed, which is a fact about the session and not about this article.
 * Counting it as an attempt would burn the whole queue's retry budget on one expired
 * cookie, so it neither counts nor reverts: the queue is left exactly as it was and
 * the caller sends the reader to unlock.
 */
const isUnauthorized = (error: unknown): boolean =>
  error instanceof ApiError && error.status === 401;

/**
 * Send everything waiting, oldest first.
 *
 * Sequential on purpose. Parallel would be faster and would also be a batch endpoint
 * in all but name — the thing this design refuses to have, because it is what turns
 * one UI bug into a hundred lost articles instead of one.
 */
export async function flushPending(options: FlushOptions = {}): Promise<FlushResult> {
  const { send = post } = options;
  const result: FlushResult = {
    sent: 0,
    deferred: 0,
    reverted: 0,
    unauthorized: false,
    tokenRejected: false,
  };

  for (const item of await readPending()) {
    try {
      await send(item.action, item.bookmark_id);
      await clearPending(item.bookmark_id);
      result.sent += 1;
    } catch (error) {
      if (isUnauthorized(error)) {
        // Stop the whole pass: every remaining action would fail the same way, and
        // each one would spend an attempt on it.
        result.unauthorized = true;
        break;
      }

      if (isTokenRejected(error)) {
        /*
         * Instapaper has refused our credentials. Like a lapsed gate this is a fact
         * about the deployment and not about any article, so it stops the pass and
         * costs nothing — but unlike a lapsed gate, nothing the reader does *in the
         * app* can fix it.
         *
         * Counting it would be the worst outcome available: five app starts with a
         * revoked token and every queued article silently reappears, un-archived,
         * with the real cause never named. That is precisely the silent failure this
         * phase exists to remove.
         */
        result.tokenRejected = true;
        break;
      }

      const message = error instanceof Error ? error.message : String(error);
      const kind = classify(error);

      if (kind === 'permanent') {
        await unmarkPurge(item.bookmark_id);
        await clearPending(item.bookmark_id);
        result.reverted += 1;
        continue;
      }

      if (kind === 'unreachable') {
        /*
         * The request never reached anything. Record *why*, so the reader can see it,
         * but leave the attempt count alone — the retry budget is for answers, and a
         * dead network is not one. Without this a train journey exhausts it.
         */
        await noteError(item.bookmark_id, message);
        result.deferred += 1;
        continue;
      }

      const attempts = await recordAttempt(item.bookmark_id, message);
      if (attempts >= MAX_ATTEMPTS) {
        // Out of attempts. Put the article back rather than leave it in a limbo the
        // reader cannot see: it is in neither Instapaper's archive nor their queue.
        await unmarkPurge(item.bookmark_id);
        await clearPending(item.bookmark_id);
        result.reverted += 1;
      } else {
        result.deferred += 1;
      }
    }
  }

  return result;
}

/**
 * A try-lock around the flush.
 *
 * Three things drain this queue — app start, coming back online, and queueing an
 * action — and on a phone rejoining a network they can fire within a few
 * milliseconds of one another. Overlapping passes would read the same rows and send
 * the same archive twice, which is exactly the duplicate call the serial loop above
 * exists to avoid.
 */
let inFlight: Promise<FlushResult> | null = null;

export function flushOnce(options: FlushOptions = {}): Promise<FlushResult> {
  inFlight ??= flushPending(options).finally(() => {
    inFlight = null;
  });
  return inFlight;
}

/** Test seam: forgets an in-flight pass between cases. Never called in production. */
export function resetFlushLock(): void {
  inFlight = null;
}
