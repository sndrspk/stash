/**
 * Fetching article text, for the few articles that need it now.
 *
 * The front page shows an excerpt under the lead story and the three cards below it.
 * When a bookmark carries a `description` that costs nothing; when it does not, the
 * only place an excerpt can come from is the article itself. So **those four fetch
 * eagerly and nothing else does** — every other article on the page is title-only,
 * and fetching its text would be paying for prose that is never shown.
 *
 * Same cache rules as the image pass, for the same reasons: a URL with an answer is
 * never asked again, a failure is recorded rather than dropped, and passes queue
 * instead of racing.
 */
import { ApiError, apiErrorFrom, isTokenRejected } from './api-error.js';
import type { BookmarkRecord } from './db.js';
import { readText, writeText } from './store.js';

export interface TextPassResult {
  requested: number;
  /** Of those, how many were already cached. */
  skipped: number;
  fetched: number;
  /** Instapaper has no text for this bookmark — a real answer, not a fault. */
  empty: number;
  failed: number;
}

const EMPTY: TextPassResult = { requested: 0, skipped: 0, fetched: 0, empty: 0, failed: 0 };

/** What one fetch can come back with. */
type TextOutcome = { kind: 'html'; html: string } | { kind: 'empty' } | { kind: 'failed' };

export interface EnsureTextOptions {
  /** Seam for tests, and the only thing here that touches the network. */
  fetchText?: (bookmarkId: number) => Promise<TextOutcome>;
  now?: () => number;
}

/**
 * Asks our own function for one article's text.
 *
 * Two failures throw rather than being recorded, and for the same reason: neither is
 * a fact about *this article*, and caching either as "no text" would outlast its
 * cause by days.
 *
 * - **401** — the gate has lapsed.
 * - **A rejected Instapaper token** — every article will fail identically until the
 *   operator runs `connect` again. Recorded per article, this pass would quietly mark
 *   the whole front page as having no text and never mention why.
 */
async function requestText(bookmarkId: number): Promise<TextOutcome> {
  const response = await fetch(`/api/text?bookmark_id=${bookmarkId}`);

  if (response.status === 401) throw new ApiError(401, 'unauthorized');
  if (!response.ok) {
    const error = await apiErrorFrom(response);
    if (isTokenRejected(error)) throw error;
    return { kind: 'failed' };
  }

  const body = (await response.json()) as { html?: string | null };
  const html = typeof body.html === 'string' ? body.html.trim() : '';
  return html === '' ? { kind: 'empty' } : { kind: 'html', html };
}

/**
 * One pass at a time, queued rather than skipped — see `images.ts` for why the
 * distinction matters. Here it matters more: each refresh reshuffles the slots, so
 * the second pass is nearly always about *different* articles.
 */
let chain: Promise<unknown> = Promise.resolve();

export function ensureText(
  bookmarks: readonly BookmarkRecord[],
  options: EnsureTextOptions = {},
): Promise<TextPassResult> {
  const next = chain.then(
    () => pass(bookmarks, options),
    () => pass(bookmarks, options),
  );
  chain = next.catch(() => undefined);
  return next;
}

async function pass(
  bookmarks: readonly BookmarkRecord[],
  options: EnsureTextOptions,
): Promise<TextPassResult> {
  const { fetchText = requestText, now = Date.now } = options;

  const distinct = new Map(bookmarks.map((bookmark) => [bookmark.bookmark_id, bookmark]));
  if (distinct.size === 0) return { ...EMPTY };

  const result: TextPassResult = { ...EMPTY, requested: distinct.size };

  // Sequential, not pooled. There are at most four, they all go to one endpoint,
  // and the reader sees them appear one after another rather than in a burst.
  for (const [id] of distinct) {
    if ((await readText(id, 'instapaper')) !== undefined) {
      result.skipped += 1;
      continue;
    }

    const outcome = await fetchText(id);
    if (outcome.kind === 'failed') {
      // Not written: unlike an image, there is no negative row to record here, and
      // an empty string cached as text would make the reading view show a blank
      // article rather than try again.
      result.failed += 1;
      continue;
    }

    // An `empty` answer is still written, as an empty row: Instapaper has no text
    // for this bookmark, and asking again on every refresh would re-derive that.
    await writeText(id, 'instapaper', outcome.kind === 'html' ? outcome.html : '', now());
    if (outcome.kind === 'html') result.fetched += 1;
    else result.empty += 1;
  }

  return result;
}

/** Test seam: forgets the queue between cases. Never called in production. */
export function resetTextPass(): void {
  chain = Promise.resolve();
}
