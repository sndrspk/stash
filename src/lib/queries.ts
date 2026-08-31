/**
 * TanStack Query over the IndexedDB layer.
 *
 * The shape worth noting: queries read from **IndexedDB**, not from the network.
 * Syncing is a separate mutation that fetches, writes to the cache, and then
 * invalidates. So the UI has exactly one source of truth, it is available offline,
 * and a failed sync leaves the last good data on screen instead of an error state.
 */
import { useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import type { BookmarkRecord } from './db.js';
import {
  applySync,
  markLocally,
  purgeExpired,
  readBookmark,
  readUnread,
  restore,
  type ArchiveSnapshot,
} from './store.js';
import type { RemoteBookmark } from './sync.js';

export const keys = {
  unread: ['bookmarks', 'unread'] as const,
  bookmark: (id: number) => ['bookmarks', id] as const,
};

/** A non-2xx from our own functions, carrying enough to explain itself. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail?: string,
  ) {
    super(detail ?? `Request failed with ${status}`);
    this.name = 'ApiError';
  }
}

async function apiFetch(path: string, init?: RequestInit): Promise<unknown> {
  const response = await fetch(path, init);

  if (!response.ok) {
    let detail: string | undefined;
    try {
      const body = (await response.json()) as { detail?: string; error?: string };
      detail = body.detail ?? body.error;
    } catch {
      // A non-JSON error body is itself informative — a crashed function returns
      // HTML — but there is nothing useful to extract from it.
    }
    throw new ApiError(response.status, detail);
  }

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

/**
 * Archive or delete, applied locally first and rolled back exactly on failure.
 *
 * The order matters. The local mark happens before the request so the article
 * leaves the queue immediately; the snapshot it returns is what makes the rollback
 * exact rather than approximate. Anything other than a 2xx puts every touched row
 * back — including an ambiguous timeout, which resolves toward showing the article
 * again rather than hiding one that may still be in the account.
 */
export function useBookmarkAction(action: 'archive' | 'delete') {
  const client = useQueryClient();

  return useMutation({
    mutationFn: async (id: number) => {
      const snapshot: ArchiveSnapshot | null = await markLocally(
        id,
        action === 'archive' ? 'archived' : 'deleted',
      );
      // Show the change before the network call, not after it.
      await client.invalidateQueries({ queryKey: ['bookmarks'] });

      try {
        await apiFetch(`/api/${action}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ bookmark_id: id }),
        });
      } catch (error) {
        if (snapshot) await restore(snapshot);
        await client.invalidateQueries({ queryKey: ['bookmarks'] });
        throw error;
      }

      return id;
    },
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
}

export type { BookmarkRecord };
