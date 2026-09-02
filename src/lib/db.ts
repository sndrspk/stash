/**
 * The IndexedDB layer: three stores, per device.
 *
 * **None of this is precious.** Bookmarks live in Instapaper, article text is
 * re-fetchable, preferences are three numbers. That matters because browsers evict:
 * iOS Safari clears site data for origins unused for about seven days unless the PWA
 * is installed to the home screen. The response is `navigator.storage.persist()`,
 * installing the app, and accepting that a wipe costs API round-trips rather than
 * data — not defensive complexity here.
 *
 * The one exception is `image_cache`, which is expensive to rebuild across hundreds
 * of third-party sites, and which the architecture gives a server-side copy
 * alongside the local one. That copy waits for the KV store in Phase 7b rather than
 * standing one up here: until then the cache is per-device, which costs a
 * re-resolution on a new device and nothing else.
 */
import { openDB, type DBSchema, type IDBPDatabase } from 'idb';

export const DB_NAME = 'stash';
/** v2 added `settings`; v3 added `pending_actions`, for archive and delete offline. */
export const DB_VERSION = 3;

/** Seven days, in milliseconds. The grace period before a purge actually happens. */
export const PURGE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * How long a failed image lookup is left alone before it may be tried again.
 *
 * A week, which is the interval `docs/EXTRACTION.md` settled on for retrying a
 * failed URL, and for the same reason: without it, every sync re-attempts every site
 * that was down once, and a first sync's failures become a standing tax paid by
 * whoever's server was unlucky that afternoon.
 */
export const IMAGE_RETRY_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Where a bookmark stands.
 *
 * `unread` means "in the Instapaper unread folder", nothing more. Reading progress
 * is deliberately ignored: an article leaves the queue by an explicit archive or
 * delete, never by being scrolled to the end.
 *
 * `gone` is ours, not Instapaper's: the bookmark vanished from the remote list
 * without us archiving or deleting it — moved to another folder, or removed from
 * another client. It is marked rather than dropped, so a sync that returns a short
 * list by mistake cannot silently destroy the local cache.
 */
export type BookmarkState = 'unread' | 'archived' | 'deleted' | 'gone';

export interface BookmarkRecord {
  bookmark_id: number;
  title: string;
  url: string;
  /** Instapaper's own timestamp, in seconds. Kept as sent. */
  time: number;
  description: string;
  hash: string;
  folder: string;
  state: BookmarkState;
  synced_at: number;
  /** Epoch ms after which this row may be purged, or null to keep. */
  purge_after: number | null;
}

/**
 * Article text, stored **beside** rather than over.
 *
 * Both sources coexist so that a bad extraction never destroys what Instapaper
 * returned, and so settings can offer "show original" for free. The key is
 * therefore composite — one row per bookmark per source.
 */
export type TextSource = 'instapaper' | 'extracted';

export interface ArticleTextRecord {
  /** `${bookmark_id}:${source}`. */
  key: string;
  bookmark_id: number;
  source: TextSource;
  html: string;
  fetched_at: number;
  purge_after: number | null;
}

export const textKey = (bookmarkId: number, source: TextSource): string =>
  `${bookmarkId}:${source}`;

/**
 * Resolved `og:image` lookups, keyed by the article's source URL.
 *
 * `none` is a **permanent** negative result: the page genuinely has no usable image,
 * and asking again will always cost a request to answer the same way. `error` is
 * temporary and may be retried. Conflating the two is what turns one sync into a
 * standing tax on every site that never had an image.
 */
export type ImageStatus = 'ok' | 'none' | 'error';

export interface ImageCacheRecord {
  url: string;
  image_url: string | null;
  status: ImageStatus;
  resolved_at: number;
  purge_after: number | null;
}

/**
 * An archive or delete that has not reached Instapaper yet.
 *
 * The queue exists because the local mark and the remote call are two things, and a
 * phone on a train does the first and not the second. Without it the only options are
 * both bad: refuse the action while offline, or accept it and lose it.
 *
 * **Keyed by `bookmark_id`, so one article can have exactly one pending intent.** Not
 * an append-only log: archiving and then deleting the same article while offline is
 * one decision changing its mind, and replaying both would send Instapaper an archive
 * for something the reader wanted gone. The last intent wins, which is also what the
 * local state already shows.
 */
export interface PendingActionRecord {
  bookmark_id: number;
  action: 'archive' | 'delete';
  queued_at: number;
  /** How many times a replay has been tried and failed. */
  attempts: number;
  /** The last failure, for the reader to see. Short, and never a stack trace. */
  last_error: string | null;
}

interface StashDB extends DBSchema {
  bookmarks: {
    key: number;
    value: BookmarkRecord;
    indexes: {
      /** The front page reads unread by recency; both indexes serve it. */
      by_state: BookmarkState;
      by_time: number;
      by_purge_after: number;
    };
  };
  article_text: {
    key: string;
    value: ArticleTextRecord;
    indexes: {
      by_bookmark: number;
      by_purge_after: number;
    };
  };
  image_cache: {
    key: string;
    value: ImageCacheRecord;
    indexes: {
      by_status: ImageStatus;
      by_purge_after: number;
    };
  };
  /**
   * One row per setting, keyed by name.
   *
   * Deliberately not one row holding an object: a store keyed by name lets a later
   * setting be added without a migration, and the reading preferences are already
   * normalised field-by-field on read.
   */
  settings: {
    key: string;
    value: unknown;
  };
  pending_actions: {
    key: number;
    value: PendingActionRecord;
    indexes: {
      /** Replayed oldest first, so the queue drains in the order it was filled. */
      by_queued_at: number;
    };
  };
}

/** The one key `settings` currently holds. */
export const READING_PREFS_KEY = 'reading';

export type StashDatabase = IDBPDatabase<StashDB>;

let cached: Promise<StashDatabase> | null = null;

/**
 * Opens (and memoises) the database.
 *
 * `blocking` fires when another tab holds an old version open. Closing immediately
 * lets that tab's upgrade proceed rather than deadlocking both; this tab reopens on
 * next use because the memo is cleared.
 */
export function getDb(): Promise<StashDatabase> {
  cached ??= openDB<StashDB>(DB_NAME, DB_VERSION, {
    /*
     * Stepwise, and additive.
     *
     * `upgrade` runs once with whatever version the device happens to be on, which
     * for a browser cache is *any* version this app has ever shipped — there is no
     * deploy that migrates everyone at once. So each version's changes are guarded
     * by their own `oldVersion` check and none of them touch data written by an
     * earlier one: a v1 device gets both blocks, a fresh device gets both, and a v2
     * device gets neither.
     */
    upgrade(db, oldVersion) {
      if (oldVersion < 1) {
        const bookmarks = db.createObjectStore('bookmarks', { keyPath: 'bookmark_id' });
        bookmarks.createIndex('by_state', 'state');
        bookmarks.createIndex('by_time', 'time');
        bookmarks.createIndex('by_purge_after', 'purge_after');

        const text = db.createObjectStore('article_text', { keyPath: 'key' });
        text.createIndex('by_bookmark', 'bookmark_id');
        text.createIndex('by_purge_after', 'purge_after');

        const images = db.createObjectStore('image_cache', { keyPath: 'url' });
        images.createIndex('by_status', 'status');
        images.createIndex('by_purge_after', 'purge_after');
      }

      if (oldVersion < 2) {
        // No index and no keyPath: the key is the setting's name, passed in.
        db.createObjectStore('settings');
      }

      if (oldVersion < 3) {
        const pending = db.createObjectStore('pending_actions', { keyPath: 'bookmark_id' });
        pending.createIndex('by_queued_at', 'queued_at');
      }
    },
    blocking() {
      void closeDb();
    },
  });
  return cached;
}

/** Closes and forgets the handle. Used by `blocking`, and by tests between cases. */
export async function closeDb(): Promise<void> {
  const handle = cached;
  cached = null;
  if (handle) (await handle).close();
}

/**
 * Asks the browser not to evict this origin.
 *
 * Best-effort by design: it is granted on heuristics we do not control (installed to
 * the home screen, engagement), it is absent entirely in some browsers, and it
 * throws in others. A false answer is not an error — it means a wipe costs
 * round-trips, which is a cost this cache is built to absorb.
 */
export async function requestPersistence(): Promise<boolean> {
  try {
    if (!navigator.storage?.persist) return false;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return false;
  }
}
