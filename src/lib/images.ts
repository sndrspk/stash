/**
 * The image resolution pass: deciding *when* to ask, and remembering the answer.
 *
 * The rule that makes this affordable is one line long — **never look up a URL that
 * already has a cache row** — and everything else here exists to keep it true. A
 * first sync resolves a few hundred images; every sync after it should resolve the
 * handful that are new and nothing else. That is the phase's whole promise, and it
 * is cheap to break: a negative result stored as an error, a retry with no interval,
 * or two passes racing each other all turn a one-off cost into a recurring one.
 *
 * So: results are deduped before the pass, `needsImageLookup` decides what survives,
 * a failure is recorded rather than dropped (an unrecorded failure is retried
 * forever), and overlapping passes share one run rather than doubling the traffic.
 */
import { ApiError } from './api-error.js';
import type { ImageStatus } from './db.js';
import { runBounded, type BoundedRunOptions } from './image-queue.js';
import { needsImageLookup, writeImage } from './store.js';

export interface ImageResolution {
  status: ImageStatus;
  image_url: string | null;
}

export interface ImagePassResult {
  /** Distinct URLs handed to the pass. */
  requested: number;
  /** Of those, how many already had an answer and cost nothing. */
  skipped: number;
  resolved: number;
  none: number;
  failed: number;
}

const EMPTY: ImagePassResult = { requested: 0, skipped: 0, resolved: 0, none: 0, failed: 0 };

export interface ResolveImagesOptions extends BoundedRunOptions {
  /** Seam for tests, and the only thing here that touches the network. */
  lookup?: (url: string, signal?: AbortSignal) => Promise<ImageResolution>;
}

/**
 * Asks our own function what image a page has.
 *
 * The status mapping is where the cache's honesty is decided:
 *
 * - **403 and 400 become `none`.** A URL that will never be fetched — a private
 *   address, a scheme we do not speak, a bookmark whose URL does not parse — has a
 *   permanent answer, and re-asking every sync would only re-derive it.
 * - **Everything else becomes `error`**, which is retried after a week rather than
 *   immediately.
 * - **401 is neither**, and throws. The gate has expired; that is not a fact about
 *   this article, and writing two hundred error rows because a cookie lapsed would
 *   poison the cache for a week.
 */
async function requestResolution(url: string, signal?: AbortSignal): Promise<ImageResolution> {
  const response = await fetch(`/api/resolve-image?url=${encodeURIComponent(url)}`, { signal });

  if (response.status === 401) throw new ApiError(401, 'unauthorized');

  if (response.ok) {
    const body = (await response.json()) as { status?: string; image_url?: string | null };
    const imageUrl = typeof body.image_url === 'string' ? body.image_url : null;
    return { status: imageUrl === null ? 'none' : 'ok', image_url: imageUrl };
  }

  if (response.status === 400 || response.status === 403)
    return { status: 'none', image_url: null };
  return { status: 'error', image_url: null };
}

/**
 * One pass at a time, and the others queue behind it.
 *
 * The problem this solves is two passes running at once: neither sees the other's
 * cache rows, because both read them before either wrote any, so every URL they
 * share is fetched twice. App start and an explicit refresh land within a second of
 * each other routinely, which is exactly that case.
 *
 * SanFeedBin's answer to the same problem was single-flight — overlapping triggers
 * skip. That is wrong here, because the second trigger is usually a *different*
 * list: a sync finishing mid-pass brings two hundred new bookmarks, and dropping
 * them would leave their pictures unresolved until the app was next opened.
 * Serialising costs nothing instead, because the queued pass reads the rows the
 * previous one just wrote and skips every URL they had in common.
 */
let chain: Promise<unknown> = Promise.resolve();

export function resolveImages(
  urls: readonly string[],
  options: ResolveImagesOptions = {},
): Promise<ImagePassResult> {
  // Both arms, so one pass's failure does not strand every pass behind it.
  const next = chain.then(
    () => pass(urls, options),
    () => pass(urls, options),
  );
  chain = next.catch(() => undefined);
  return next;
}

async function pass(
  urls: readonly string[],
  options: ResolveImagesOptions,
): Promise<ImagePassResult> {
  const { lookup = requestResolution, now = Date.now, ...queueOptions } = options;

  const distinct = [...new Set(urls.filter((url) => url.trim() !== ''))];
  if (distinct.length === 0) return { ...EMPTY };

  const wanted: string[] = [];
  for (const url of distinct) {
    if (await needsImageLookup(url, now())) wanted.push(url);
  }

  const result: ImagePassResult = {
    ...EMPTY,
    requested: distinct.length,
    skipped: distinct.length - wanted.length,
  };
  if (wanted.length === 0) return result;

  // A lapsed gate stops the pass rather than recording two hundred failures. The
  // controller also chains the caller's own signal, so a cancelled sync cancels this.
  const stop = new AbortController();
  const abortAll = () => stop.abort();
  queueOptions.signal?.addEventListener('abort', abortAll, { once: true });
  let unauthorized: ApiError | null = null;

  try {
    await runBounded(
      wanted,
      async (url) => {
        let resolution: ImageResolution;
        try {
          resolution = await lookup(url, stop.signal);
        } catch (error) {
          if (error instanceof ApiError && error.status === 401) {
            unauthorized = error;
            stop.abort();
            return;
          }
          // Offline, a crashed function, a body that would not parse: all one thing
          // from here, and all retryable.
          resolution = { status: 'error', image_url: null };
        }

        await writeImage({
          url,
          image_url: resolution.image_url,
          status: resolution.status,
          resolved_at: now(),
          purge_after: null,
        });

        if (resolution.status === 'ok') result.resolved += 1;
        else if (resolution.status === 'none') result.none += 1;
        else result.failed += 1;
      },
      { ...queueOptions, now, signal: stop.signal },
    );
  } finally {
    queueOptions.signal?.removeEventListener('abort', abortAll);
  }

  if (unauthorized !== null) throw unauthorized;
  return result;
}

/** Test seam: forgets the queue between cases. Never called in production. */
export function resetImagePass(): void {
  chain = Promise.resolve();
}
