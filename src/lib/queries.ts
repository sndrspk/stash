/**
 * TanStack Query over the IndexedDB layer.
 *
 * The shape worth noting: queries read from **IndexedDB**, not from the network.
 * Syncing is a separate mutation that fetches, writes to the cache, and then
 * invalidates. So the UI has exactly one source of truth, it is available offline,
 * and a failed sync leaves the last good data on screen instead of an error state.
 */
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { ApiError, apiErrorFrom } from './api-error.js';
import type { BookmarkRecord } from './db.js';
import { extractArticle, type ExtractionResult } from './extraction.js';
import { resolveImages, type ImagePassResult } from './images.js';
import { flushOnce, type FlushResult } from './pending.js';
import type { ReadingPrefs } from './prefs.js';
import {
  applySync,
  clearCache,
  markLocally,
  purgeExpired,
  queueAction,
  readAllImages,
  readBestText,
  readBookmark,
  readCacheUsage,
  readPending,
  readPrefs,
  readTextFor,
  readTextSources,
  readUnread,
  writePrefs,
} from './store.js';
import type { RemoteBookmark } from './sync.js';
import { ensureText, type TextPassResult } from './text.js';

export const keys = {
  unread: ['bookmarks', 'unread'] as const,
  bookmark: (id: number) => ['bookmarks', id] as const,
  images: ['images'] as const,
  text: (ids: readonly number[]) => ['text', [...ids].sort((a, b) => a - b)] as const,
  article: (id: number) => ['article', id] as const,
  /** Both sources for one article, so "show original" needs no second fetch. */
  articleSources: (id: number) => ['article', id, 'sources'] as const,
  prefs: ['prefs'] as const,
  /** Archive and delete actions that have not reached Instapaper yet. */
  pending: ['pending'] as const,
  /** What the cache is holding, for the settings screen. */
  usage: ['usage'] as const,
  /** The last replay's verdict, so the front page can report it. */
  flush: ['flush'] as const,
};

export { ApiError };

async function apiFetch(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, init);
  if (!response.ok) throw await apiErrorFrom(response);
  return response.json();
}

export function useUnreadBookmarks() {
  return useQuery({
    queryKey: keys.unread,
    queryFn: readUnread,
    // The cache is the source of truth and only this app writes it, so there is no
    // staleness to poll for; a sync invalidates explicitly when it changes things.
    staleTime: Infinity,
  });
}

export function useBookmark(id: number) {
  return useQuery({
    queryKey: keys.bookmark(id),
    queryFn: () => readBookmark(id),
    staleTime: Infinity,
  });
}

/**
 * Fetches the unread list and reconciles it into IndexedDB.
 *
 * Deliberately a mutation rather than a query: it writes, it is triggered by an
 * explicit refresh or app start, and it must not be re-run automatically on window
 * focus — each run is an authenticated round trip to a third-party API.
 */
export function useSync() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: async () => {
      const body = (await apiFetch('/api/bookmarks')) as { bookmarks: RemoteBookmark[] };
      return applySync(body.bookmarks ?? []);
    },
    onSuccess: () => client.invalidateQueries({ queryKey: ['bookmarks'] }),
  });
}

/** The resolved images, as a map the front page can look an article's URL up in. */
export function useImageCache() {
  return useQuery({
    queryKey: keys.images,
    queryFn: readAllImages,
    staleTime: Infinity,
  });
}

/**
 * Resolves images for the unread queue.
 *
 * A mutation, and separate from `useSync`, for two reasons. It writes; and it is
 * slow by design — a few hundred throttled fetches of other people's pages — which
 * must not be what a refresh waits on. Sync brings the list back in a round trip and
 * the pictures arrive behind it.
 *
 * It resolves only what has no cached answer, so the second run over the same queue
 * makes no requests at all.
 */
export function useResolveImages() {
  const client = useQueryClient();

  return useMutation<ImagePassResult, Error, readonly string[]>({
    mutationFn: (urls) => resolveImages(urls),
    onSuccess: (result) => {
      if (result.resolved > 0 || result.none > 0 || result.failed > 0) {
        void client.invalidateQueries({ queryKey: keys.images });
      }
    },
  });
}

/** The reader's typography settings, and the one mutation that changes them. */
export function useReadingPrefs() {
  return useQuery({
    queryKey: keys.prefs,
    queryFn: readPrefs,
    staleTime: Infinity,
  });
}

export function useSetReadingPrefs() {
  const client = useQueryClient();

  return useMutation<ReadingPrefs, Error, ReadingPrefs>({
    mutationFn: async (prefs) => {
      await writePrefs(prefs);
      return prefs;
    },
    // Written straight into the query cache rather than invalidated: preferences
    // apply live, and a round trip through IndexedDB between the reader moving a
    // slider and the article reflowing would be visible as a stutter.
    onSuccess: (prefs) => client.setQueryData(keys.prefs, prefs),
  });
}

/**
 * One article's text, from the cache, fetching it if this is the first time.
 *
 * Unlike the front page's eager pass this is a query: the reader is waiting for it,
 * there is exactly one, and there is nothing else to show until it arrives.
 */
export function useArticleText(id: number) {
  return useQuery({
    queryKey: keys.article(id),
    queryFn: async () => {
      const cached = await readBestText(id);
      if (cached !== undefined) return cached.html;

      await ensureText([{ bookmark_id: id } as BookmarkRecord]);
      return (await readBestText(id))?.html ?? '';
    },
    staleTime: Infinity,
    enabled: Number.isInteger(id) && id > 0,
  });
}

/**
 * Both stored copies of one article.
 *
 * This is what "store beside, never over" buys: the reading view can offer the
 * original with nothing fetched and nothing lost, because the Instapaper text was
 * never overwritten in the first place.
 */
export function useArticleSources(id: number) {
  return useQuery({
    queryKey: keys.articleSources(id),
    queryFn: () => readTextSources(id),
    staleTime: Infinity,
    enabled: Number.isInteger(id) && id > 0,
  });
}

/**
 * Re-extract one article from the publisher's own page.
 *
 * Every gate lives in `extraction.ts`, including the one that matters here: passing
 * `force` is what an explicit "fetch full content" does, and it skips the truncation
 * check, the backoff and the already-extracted check alike.
 */
export function useExtractArticle() {
  const client = useQueryClient();

  return useMutation<ExtractionResult, Error, { bookmark: BookmarkRecord; force?: boolean }>({
    mutationFn: ({ bookmark, force }) => extractArticle(bookmark, { force }),
    onSuccess: (result, { bookmark }) => {
      if (result.outcome?.kind === 'extracted') {
        void client.invalidateQueries({ queryKey: ['article', bookmark.bookmark_id] });
      }
    },
  });
}

/** Cached text for the handful of articles whose excerpt has to be derived. */
export function useTextFor(ids: readonly number[]) {
  return useQuery({
    queryKey: keys.text(ids),
    queryFn: () => readTextFor(ids),
    staleTime: Infinity,
  });
}

/**
 * Fetches text for the four slot articles that carry no `description`.
 *
 * Eager, unlike everything else: an excerpt is on screen the moment the slot is, so
 * waiting for the reader to open the article is too late. It is still only ever four
 * requests, and only for the ones that need it.
 */
export function useEnsureText() {
  const client = useQueryClient();

  return useMutation<TextPassResult, Error, readonly BookmarkRecord[]>({
    mutationFn: (bookmarks) => ensureText(bookmarks),
    onSuccess: (result) => {
      if (result.fetched > 0 || result.empty > 0) {
        void client.invalidateQueries({ queryKey: ['text'] });
      }
    },
  });
}

/**
 * Archive or delete: marked locally, queued, and sent.
 *
 * The order matters and has not changed — the local mark happens first, so the
 * article leaves the queue the moment it is clicked rather than when the network
 * agrees. What changed is what happens when the network does not agree.
 *
 * It used to roll back on any non-2xx, which is right for a request that is wrong and
 * exactly wrong for one that never left the building. A reader on a train archiving
 * five articles would watch all five come back. So the intent is written to disk
 * first and the send is a flush of that queue: a transient failure keeps the intent
 * and replays it on reconnect, and only a genuinely permanent one puts the article
 * back. `flushPending` owns that distinction; this owns the ordering.
 *
 * The mutation still resolves rather than throwing when the send fails, because a
 * queued action is not an error the reader needs to see as one — the pending count
 * on the front page is how it is reported.
 */
export function useBookmarkAction(action: 'archive' | 'delete') {
  const client = useQueryClient();

  return useMutation<FlushResult, Error, number>({
    mutationFn: async (id: number) => {
      await markLocally(id, action === 'archive' ? 'archived' : 'deleted');
      await queueAction(id, action);
      // Show the change before the network call, not after it.
      await client.invalidateQueries({ queryKey: ['bookmarks'] });

      return flushOnce();
    },
    onSuccess: (result) => client.setQueryData(keys.flush, result),
    onSettled: () => {
      void client.invalidateQueries({ queryKey: keys.pending });
      void client.invalidateQueries({ queryKey: ['bookmarks'] });
    },
  });
}

/**
 * What the cache is holding.
 *
 * `staleTime: 0`, unlike almost everything else here: this is the one query whose
 * whole job is to be current, and a reader who has just cleared the cache and sees
 * the old figure will reasonably conclude nothing happened.
 */
export function useCacheUsage() {
  return useQuery({ queryKey: keys.usage, queryFn: readCacheUsage, staleTime: 0 });
}

/**
 * Drop the cached text and images.
 *
 * Every invalidation below is needed, and for a different reason: the article queries
 * are now wrong, the image map is now empty, and the usage figure is the thing the
 * reader is watching to know it worked.
 */
export function useClearCache() {
  const client = useQueryClient();

  return useMutation({
    mutationFn: clearCache,
    onSuccess: async () => {
      await client.invalidateQueries({ queryKey: ['article'] });
      await client.invalidateQueries({ queryKey: ['text'] });
      await client.invalidateQueries({ queryKey: keys.images });
      await client.invalidateQueries({ queryKey: keys.usage });
    },
  });
}

/** What is waiting to reach Instapaper, for the front page to report. */
export function usePendingActions() {
  return useQuery({
    queryKey: keys.pending,
    queryFn: readPending,
    staleTime: Infinity,
  });
}

/**
 * Drain the queue.
 *
 * Exposed as a plain function rather than a hook because its two most important
 * callers are not React: the `online` event, and app start. `flushOnce` is what makes
 * three near-simultaneous triggers into one pass.
 */
export async function runPendingFlush(client: QueryClient): Promise<FlushResult> {
  const result = await flushOnce();
  if (result.sent > 0 || result.reverted > 0) {
    await client.invalidateQueries({ queryKey: ['bookmarks'] });
  }
  await client.invalidateQueries({ queryKey: keys.pending });
  /*
   * Written into the cache rather than returned to nobody. The flush's most important
   * outcome — Instapaper refused the token — happens on app start, where there is no
   * component waiting on the promise, and it is the one thing the reader has to be
   * told rather than left to infer from articles quietly reappearing.
   */
  client.setQueryData(keys.flush, result);
  return result;
}

/** The last replay's verdict. Undefined until one has run. */
export function useLastFlush() {
  return useQuery<FlushResult | undefined>({
    queryKey: keys.flush,
    // Never fetches: this is a slot that `runPendingFlush` and the action mutation
    // write into, and a query is simply the subscription mechanism.
    queryFn: () => undefined,
    staleTime: Infinity,
  });
}

/**
 * The purge sweep, run once at app start.
 *
 * This is why there is no scheduled job in the design: the only moment cached rows
 * need collecting is the moment someone opens the app.
 */
export async function runStartupPurge(client: QueryClient): Promise<void> {
  const result = await purgeExpired();
  if (result.texts > 0 || result.images > 0) {
    await client.invalidateQueries({ queryKey: ['bookmarks'] });
  }
  if (result.images > 0) {
    await client.invalidateQueries({ queryKey: keys.images });
  }
}

export type { BookmarkRecord };
