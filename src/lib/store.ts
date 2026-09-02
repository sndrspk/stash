/**
 * Operations over the IndexedDB stores.
 *
 * The decisions live in `sync.ts` (what to write) and here (how to write it
 * atomically). Anything that touches more than one row does so inside a single
 * transaction, so a tab closed mid-sync leaves the cache consistent rather than
 * half-updated.
 */
import { DEFAULT_PREFS, normalizePrefs, type ReadingPrefs } from './prefs.js';
import {
  IMAGE_RETRY_MS,
  PURGE_GRACE_MS,
  READING_PREFS_KEY,
  getDb,
  textKey,
  type ArticleTextRecord,
  type BookmarkRecord,
  type BookmarkState,
  type ImageCacheRecord,
  type PendingActionRecord,
  type TextSource,
} from './db.js';
import { reconcile, type RemoteBookmark } from './sync.js';

/** Every unread bookmark, newest first. */
export async function readUnread(): Promise<BookmarkRecord[]> {
  const db = await getDb();
  const rows = await db.getAllFromIndex('bookmarks', 'by_state', 'unread');
  return rows.sort((a, b) => b.time - a.time);
}

export async function readBookmark(id: number): Promise<BookmarkRecord | undefined> {
  return (await getDb()).get('bookmarks', id);
}

export interface SyncResult {
  upserted: number;
  markedGone: number;
}

/**
 * Applies a fetched bookmark list.
 *
 * One transaction: reading the local rows, writing the upserts and marking the
 * absentees all commit together, so an interrupted sync cannot leave rows marked
 * `gone` without the writes that justified it.
 */
export async function applySync(
  remote: readonly RemoteBookmark[],
  now = Date.now(),
): Promise<SyncResult> {
  const db = await getDb();
  const tx = db.transaction('bookmarks', 'readwrite');
  const store = tx.objectStore('bookmarks');

  const local = await store.getAll();
  const { upserts, gone } = reconcile(local, remote, now);

  for (const row of upserts) await store.put(row);

  for (const id of gone) {
    const row = await store.get(id);
    if (row) await store.put({ ...row, state: 'gone', synced_at: now });
  }

  await tx.done;
  return { upserted: upserts.length, markedGone: gone.length };
}

/**
 * Marks a bookmark archived or deleted locally, and schedules its cached text and
 * image for purging after the grace period.
 *
 * Returns what the rows looked like before, so a failed API call can put them back
 * exactly — an optimistic update is only safe if the rollback is exact.
 */
export interface ArchiveSnapshot {
  bookmark: BookmarkRecord;
  texts: ArticleTextRecord[];
  image: ImageCacheRecord | undefined;
}

export async function markLocally(
  id: number,
  state: Extract<BookmarkState, 'archived' | 'deleted'>,
  now = Date.now(),
): Promise<ArchiveSnapshot | null> {
  const db = await getDb();
  const tx = db.transaction(['bookmarks', 'article_text', 'image_cache'], 'readwrite');

  const bookmarks = tx.objectStore('bookmarks');
  const bookmark = await bookmarks.get(id);
  if (!bookmark) {
    await tx.done;
    return null;
  }

  const texts = await tx.objectStore('article_text').index('by_bookmark').getAll(id);
  const image = await tx.objectStore('image_cache').get(bookmark.url);

  const purgeAfter = now + PURGE_GRACE_MS;

  await bookmarks.put({ ...bookmark, state, purge_after: purgeAfter });
  for (const text of texts) {
    await tx.objectStore('article_text').put({ ...text, purge_after: purgeAfter });
  }
  if (image) {
    await tx.objectStore('image_cache').put({ ...image, purge_after: purgeAfter });
  }

  await tx.done;
  return { bookmark, texts, image };
}

/** Puts back exactly what `markLocally` captured, for when the API call fails. */
export async function restore(snapshot: ArchiveSnapshot): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(['bookmarks', 'article_text', 'image_cache'], 'readwrite');

  await tx.objectStore('bookmarks').put(snapshot.bookmark);
  for (const text of snapshot.texts) await tx.objectStore('article_text').put(text);
  if (snapshot.image) await tx.objectStore('image_cache').put(snapshot.image);

  await tx.done;
}

export interface PurgeResult {
  texts: number;
  images: number;
}

/**
 * Drops cached text and images whose grace period has expired.
 *
 * Runs as a sweep on app start, which is why there is no scheduled job anywhere in
 * this design. It deletes **only** rows whose `purge_after` is set and in the past;
 * a null `purge_after` means keep, and is the common case.
 *
 * The bookmark rows themselves are not deleted. They are small, and keeping them is
 * what lets an archived article be recognised rather than re-fetched if it comes
 * back.
 */
export async function purgeExpired(now = Date.now()): Promise<PurgeResult> {
  const db = await getDb();
  const tx = db.transaction(['article_text', 'image_cache'], 'readwrite');

  // Upper-bound the range rather than scanning: rows with a null purge_after are
  // not in the index at all, so they are never even considered.
  const expired = IDBKeyRange.upperBound(now, true);

  let texts = 0;
  for (const key of await tx
    .objectStore('article_text')
    .index('by_purge_after')
    .getAllKeys(expired)) {
    await tx.objectStore('article_text').delete(key);
    texts++;
  }

  let images = 0;
  for (const key of await tx
    .objectStore('image_cache')
    .index('by_purge_after')
    .getAllKeys(expired)) {
    await tx.objectStore('image_cache').delete(key);
    images++;
  }

  await tx.done;
  return { texts, images };
}

/**
 * Undoes a local mark: back to `unread`, purge cancelled on the text and the image.
 *
 * Written in Phase 3 against a caller that did not exist yet; the offline queue is
 * that caller. It is the counterpart to `restore` for the case where there is no
 * snapshot to restore from — a queued action can be replayed by a page load days
 * later, so the undo has to be reconstructible from what is on disk.
 *
 * Approximate where `restore` is exact: it returns the article to `unread` rather
 * than to whatever it was. Nothing can reach it in another state — only an unread
 * article can be archived or deleted from the UI, and one that has genuinely moved on
 * comes back as `gone` from the next sync rather than from here.
 */
export async function unmarkPurge(id: number): Promise<void> {
  const db = await getDb();
  const tx = db.transaction(['bookmarks', 'article_text', 'image_cache'], 'readwrite');

  const bookmark = await tx.objectStore('bookmarks').get(id);
  if (bookmark) {
    await tx.objectStore('bookmarks').put({ ...bookmark, state: 'unread', purge_after: null });
    const image = await tx.objectStore('image_cache').get(bookmark.url);
    if (image) await tx.objectStore('image_cache').put({ ...image, purge_after: null });
  }

  for (const text of await tx.objectStore('article_text').index('by_bookmark').getAll(id)) {
    await tx.objectStore('article_text').put({ ...text, purge_after: null });
  }

  await tx.done;
}

// --- article text ---

export async function readText(
  id: number,
  source: TextSource,
): Promise<ArticleTextRecord | undefined> {
  return (await getDb()).get('article_text', textKey(id, source));
}

/**
 * Both sources for a bookmark, reduced to the one the reading view should show.
 *
 * Extracted wins when present, because it only exists when `get_text` came back
 * truncated — but **only when it has something in it**. An empty `extracted` row is
 * not an article: it is how `extraction.ts` records a failed attempt and starts the
 * week before the next one. Preferring it blindly would answer a perfectly good
 * Instapaper article with a blank screen, and would do so precisely for the
 * articles where extraction was needed and did not work.
 */
export function bestOf(rows: readonly ArticleTextRecord[]): ArticleTextRecord | undefined {
  const extracted = rows.find((row) => row.source === 'extracted');
  if (extracted !== undefined && extracted.html.trim() !== '') return extracted;
  return rows.find((row) => row.source === 'instapaper');
}

export async function readBestText(id: number): Promise<ArticleTextRecord | undefined> {
  return bestOf(await (await getDb()).getAllFromIndex('article_text', 'by_bookmark', id));
}

export interface TextSources {
  instapaper: string | null;
  extracted: string | null;
}

/**
 * Both copies, as they are stored.
 *
 * An empty extracted row reads back as `null` rather than as an empty string: it is
 * a recorded failure, not an article, and the reading view should offer no toggle
 * for it.
 */
export async function readTextSources(id: number): Promise<TextSources> {
  const rows = await (await getDb()).getAllFromIndex('article_text', 'by_bookmark', id);
  const pick = (source: TextSource) => {
    const html = rows.find((row) => row.source === source)?.html ?? '';
    return html.trim() === '' ? null : html;
  };
  return { instapaper: pick('instapaper'), extracted: pick('extracted') };
}

/**
 * The best available text for each of several bookmarks, as one map.
 *
 * The front page needs this for up to four articles at once, and one transaction
 * beats four round trips through the same store.
 */
export async function readTextFor(ids: readonly number[]): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map();

  const db = await getDb();
  const tx = db.transaction('article_text', 'readonly');
  const index = tx.objectStore('article_text').index('by_bookmark');

  const out = new Map<number, string>();
  for (const id of new Set(ids)) {
    const rows = await index.getAll(id);
    const best = bestOf(rows);
    if (best) out.set(id, best.html);
  }

  await tx.done;
  return out;
}

export async function writeText(
  id: number,
  source: TextSource,
  html: string,
  now = Date.now(),
): Promise<void> {
  // Store beside, never over: writing the extracted copy must not destroy what
  // Instapaper returned, so the key includes the source.
  await (
    await getDb()
  ).put('article_text', {
    key: textKey(id, source),
    bookmark_id: id,
    source,
    html,
    fetched_at: now,
    purge_after: null,
  });
}

// --- reading preferences ---

/**
 * The stored preferences, normalised.
 *
 * A missing row and a corrupt one are the same thing from here: the defaults. There
 * is nothing in this store worth recovering carefully — they are four values a
 * reader can set again in seconds — and the reading view must never fail to open
 * because a preference did not parse.
 */
export async function readPrefs(): Promise<ReadingPrefs> {
  try {
    return normalizePrefs(await (await getDb()).get('settings', READING_PREFS_KEY));
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

export async function writePrefs(prefs: ReadingPrefs): Promise<void> {
  await (await getDb()).put('settings', prefs, READING_PREFS_KEY);
}

// --- image cache ---

export async function readImage(url: string): Promise<ImageCacheRecord | undefined> {
  return (await getDb()).get('image_cache', url);
}

export async function writeImage(record: ImageCacheRecord): Promise<void> {
  await (await getDb()).put('image_cache', record);
}

/** Every resolved image, keyed by article URL, for the front page to read. */
export async function readAllImages(): Promise<Map<string, ImageCacheRecord>> {
  const rows = await (await getDb()).getAll('image_cache');
  return new Map(rows.map((row) => [row.url, row]));
}

/**
 * Whether an image lookup is worth making.
 *
 * A `none` result is permanent — the page has no usable image and never will within
 * this cache's lifetime — so it must never be retried. `error` may be transient, so
 * it is allowed through, but only once the retry interval has passed: "may be
 * retried" and "is retried on every sync" are different rules, and only the first
 * one is kind to a site that was down when we happened to ask.
 */
export async function needsImageLookup(url: string, now = Date.now()): Promise<boolean> {
  const existing = await readImage(url);
  if (!existing) return true;
  if (existing.status !== 'error') return false;
  return now - existing.resolved_at >= IMAGE_RETRY_MS;
}

/* --- the pending-action queue --- */

/**
 * Record an intent, replacing any earlier one for the same article.
 *
 * `put` rather than `add`, because the key is the bookmark: a reader who archives and
 * then deletes the same article offline has changed their mind, not queued two jobs.
 * The attempt count resets with the new intent, which is right — a fresh decision has
 * not failed yet.
 */
export async function queueAction(
  id: number,
  action: PendingActionRecord['action'],
  now = Date.now(),
): Promise<void> {
  await (
    await getDb()
  ).put('pending_actions', {
    bookmark_id: id,
    action,
    queued_at: now,
    attempts: 0,
    last_error: null,
  });
}

/** Everything waiting, oldest first — the order it will be replayed in. */
export async function readPending(): Promise<PendingActionRecord[]> {
  return (await getDb()).getAllFromIndex('pending_actions', 'by_queued_at');
}

export async function readPendingFor(id: number): Promise<PendingActionRecord | undefined> {
  return (await getDb()).get('pending_actions', id);
}

export async function clearPending(id: number): Promise<void> {
  await (await getDb()).delete('pending_actions', id);
}

/**
 * Note that a replay failed, without losing the intent.
 *
 * Read-modify-write inside one transaction: two flushes racing on the same row would
 * otherwise both read `attempts: 2` and both write `3`, and the cap that exists to
 * stop an unreplayable action retrying forever would never be reached.
 */
export async function recordAttempt(id: number, error: string): Promise<number> {
  return bumpPending(id, error, true);
}

/**
 * Record why a replay failed **without** counting it as an attempt.
 *
 * For the failure that never reached a server. The reader still wants to see the
 * reason on the settings screen or in a log; what they must not get is an article
 * reverted because their train went through a tunnel five times.
 */
export async function noteError(id: number, error: string): Promise<void> {
  await bumpPending(id, error, false);
}

async function bumpPending(id: number, error: string, count: boolean): Promise<number> {
  const db = await getDb();
  const tx = db.transaction('pending_actions', 'readwrite');
  const existing = await tx.store.get(id);
  if (!existing) {
    await tx.done;
    return 0;
  }
  const attempts = count ? existing.attempts + 1 : existing.attempts;
  await tx.store.put({ ...existing, attempts, last_error: error });
  await tx.done;
  return attempts;
}

/* --- what the cache is holding --- */

export interface CacheUsage {
  /** Bookmarks in any state, including archived ones kept so they are recognised. */
  bookmarks: number;
  /** Cached article bodies, counting both sources separately. */
  texts: number;
  images: number;
  /** Archive and delete actions that have not reached Instapaper yet. */
  pending: number;
  /**
   * Bytes this origin is using, from `navigator.storage.estimate()`, or null.
   *
   * Null rather than zero when the browser will not say, which is a real case:
   * the API is absent in some browsers and throws in others. Null renders as
   * "unknown" and zero would render as "empty", and only one of those is true.
   *
   * It is also an **origin-wide** figure, not this database's: it includes the
   * service worker's precache and the article images it holds. That is arguably the
   * more useful number — it is what the browser counts against its quota, and what
   * a reader means by "how much space is this taking" — but it is not the size of
   * the rows counted above, and the screen says so rather than implying otherwise.
   */
  bytes: number | null;
}

export async function readCacheUsage(): Promise<CacheUsage> {
  const db = await getDb();
  const tx = db.transaction(['bookmarks', 'article_text', 'image_cache', 'pending_actions']);

  const [bookmarks, texts, images, pending] = await Promise.all([
    tx.objectStore('bookmarks').count(),
    tx.objectStore('article_text').count(),
    tx.objectStore('image_cache').count(),
    tx.objectStore('pending_actions').count(),
  ]);
  await tx.done;

  let bytes: number | null = null;
  try {
    if (navigator.storage?.estimate) bytes = (await navigator.storage.estimate()).usage ?? null;
  } catch {
    // Some browsers throw rather than answer. Unknown is the honest result.
  }

  return { bookmarks, texts, images, pending, bytes };
}

export interface ClearResult {
  texts: number;
  images: number;
}

/**
 * Drop the cached article text and images.
 *
 * Deliberately **not** a wipe of the database, and the three things it leaves behind
 * are the point:
 *
 * - **Pending actions stay.** They are not cache — they are decisions the reader made
 *   that Instapaper has not heard yet, and clearing them would silently un-archive
 *   articles at the one moment someone is trying to free space rather than change
 *   their queue.
 * - **Preferences stay.** Nobody clearing a cache is asking to have their typeface
 *   reset.
 * - **Bookmark rows stay.** They are tiny, they come back on the next sync anyway,
 *   and keeping them is what lets an already-archived article be recognised rather
 *   than re-fetched if it reappears.
 *
 * What goes is what is expensive and re-fetchable, which is the definition of a cache.
 */
export async function clearCache(): Promise<ClearResult> {
  const db = await getDb();
  const tx = db.transaction(['article_text', 'image_cache'], 'readwrite');

  const texts = await tx.objectStore('article_text').count();
  const images = await tx.objectStore('image_cache').count();
  await tx.objectStore('article_text').clear();
  await tx.objectStore('image_cache').clear();
  await tx.done;

  return { texts, images };
}
