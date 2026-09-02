/**
 * When to re-extract an article, and what to do with the result.
 *
 * The fetch itself lives in `api/extract`; this is the set of decisions around it,
 * which is the part `docs/EXTRACTION.md` is most specific about because it is the
 * part that goes wrong quietly:
 *
 * - **Gated on the heuristic, not on a hunch.** Extraction runs only when
 *   Instapaper's own text trips the truncation check. A full article is not
 *   re-fetched because a publisher is on some list.
 * - **A week between retries, in code rather than in the query.** The spec is
 *   emphatic about the placement: a backoff expressed as a filter silently
 *   overrides an explicit "fetch this now", because the row is simply not there to
 *   act on. Here the interval is a comparison the caller can be told to skip.
 * - **Single-flight.** Overlapping triggers skip rather than queue — unlike the
 *   image and text passes, where a second call is usually about different articles,
 *   two extraction passes are about the same article a reader just opened twice.
 * - **A user-initiated extraction bypasses every gate.** An explicit "fetch full
 *   content" is a decision, not a hint.
 * - **Store beside, never over.** The extracted copy is written under its own
 *   source key, so a bad extraction never destroys what Instapaper returned and
 *   "show original" costs nothing.
 */
import { ApiError } from './api-error.js';
import type { BookmarkRecord } from './db.js';
import { readText, writeText } from './store.js';
import { isTruncated } from './truncation.js';

/** The spec's interval, and the same one the image cache uses for a failed lookup. */
export const RETRY_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export type ExtractOutcome =
  | { kind: 'extracted'; html: string; truncated: boolean }
  | { kind: 'failed'; tag: string }
  | { kind: 'blocked'; tag: string };

export interface ExtractionResult {
  /** What happened, for the caller to show. */
  outcome: ExtractOutcome | null;
  /** Why nothing was attempted, when nothing was. */
  skipped?: 'not-truncated' | 'already-extracted' | 'backoff' | 'in-flight' | 'no-url';
}

export interface ExtractOptions {
  /** An explicit request from the reader, which bypasses every gate. */
  force?: boolean;
  /** Seam for tests; the only thing here that touches the network. */
  fetchExtract?: (url: string, excerpt: string) => Promise<ExtractOutcome>;
  now?: () => number;
}

/**
 * Asks our own function to re-extract one article.
 *
 * A 401 throws rather than being recorded, for the reason it always does: the gate
 * has lapsed, which is not a fact about this article.
 */
async function requestExtract(url: string, excerpt: string): Promise<ExtractOutcome> {
  const query = new URLSearchParams({ url });
  if (excerpt !== '') query.set('excerpt', excerpt);

  const response = await fetch(`/api/extract?${query.toString()}`);
  if (response.status === 401) throw new ApiError(401, 'unauthorized');

  if (response.status === 403 || response.status === 400) {
    const body = (await response.json().catch(() => ({}))) as { detail?: string };
    // Permanent: this URL will never be fetched, so there is nothing to retry.
    return { kind: 'blocked', tag: body.detail ?? 'refused' };
  }
  if (!response.ok) return { kind: 'failed', tag: `HTTP ${response.status}` };

  const body = (await response.json()) as {
    ok?: boolean;
    html?: string;
    tag?: string;
    truncated?: boolean;
  };
  if (body.ok !== true || typeof body.html !== 'string' || body.html.trim() === '') {
    return { kind: 'failed', tag: body.tag ?? 'Extraction returned nothing' };
  }
  return { kind: 'extracted', html: body.html, truncated: body.truncated === true };
}

/**
 * Whether Instapaper's own text is good enough.
 *
 * Exported because the reading view asks the same question to decide whether to
 * offer the "fetch full content" action, and the two must not disagree.
 */
export function needsExtraction(instapaperHtml: string | undefined): boolean {
  if (instapaperHtml === undefined || instapaperHtml.trim() === '') return true;
  return isTruncated(instapaperHtml).truncated;
}

/**
 * A try-lock, not a queue.
 *
 * Overlapping triggers skip. Unlike the image and text passes — where a second call
 * is usually about a different set and queuing is right — two extraction attempts
 * are about the article a reader just opened, so the second has nothing to add and
 * would double the load on a publisher for one page view.
 */
const inFlight = new Set<number>();

export async function extractArticle(
  bookmark: BookmarkRecord,
  options: ExtractOptions = {},
): Promise<ExtractionResult> {
  const { force = false, fetchExtract = requestExtract, now = Date.now } = options;
  const id = bookmark.bookmark_id;

  if (bookmark.url.trim() === '') return { outcome: null, skipped: 'no-url' };

  /*
   * The lock is taken **before** the gates, not after them.
   *
   * Every gate below is an `await` on IndexedDB, and a lock acquired after them is
   * not a lock: two calls a millisecond apart both read, both find nothing in
   * flight, and both fetch. Checking and adding with no `await` between them is what
   * makes this atomic on a single-threaded runtime, and it is the whole mechanism.
   */
  if (inFlight.has(id)) return { outcome: null, skipped: 'in-flight' };
  inFlight.add(id);

  try {
    if (!force) {
      const existing = await readText(id, 'extracted');
      if (existing !== undefined) {
        // A previous success. Nothing to do — and nothing to retry, because a good
        // extraction does not go stale.
        if (existing.html.trim() !== '') return { outcome: null, skipped: 'already-extracted' };

        /*
         * An empty row is a recorded *failure*, and the week starts from when it
         * was written. Written rather than dropped for exactly this: a failure
         * nobody recorded is a failure retried on every open.
         */
        if (now() - existing.fetched_at < RETRY_AFTER_MS) {
          return { outcome: null, skipped: 'backoff' };
        }
      }

      const instapaper = await readText(id, 'instapaper');
      if (!needsExtraction(instapaper?.html)) return { outcome: null, skipped: 'not-truncated' };
    }

    const outcome = await fetchExtract(bookmark.url, bookmark.description);

    if (outcome.kind === 'extracted') {
      // Beside, never over: the Instapaper row is untouched, which is what makes
      // "show original" free and a bad extraction non-destructive.
      await writeText(id, 'extracted', outcome.html, now());
    } else {
      // The empty row *is* the record of the failure, and the start of the week.
      await writeText(id, 'extracted', '', now());
    }

    return { outcome };
  } finally {
    inFlight.delete(id);
  }
}

/** Test seam: forgets in-flight articles between cases. Never called in production. */
export function resetExtractionLocks(): void {
  inFlight.clear();
}
