/**
 * Operations over the IndexedDB stores.
 *
 * The decisions live in `sync.ts` (what to write) and here (how to write it
 * atomically). Anything that touches more than one row does so inside a single
 * transaction, so a tab closed mid-sync leaves the cache consistent rather than
 * half-updated.
 */
import {
  IMAGE_RETRY_MS,
  PURGE_GRACE_MS,
  getDb,
  textKey,
  type ArticleTextRecord,
  type BookmarkRecord,
  type BookmarkState,
  type ImageCacheRecord,
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

/** Clears the purge mark, e.g. when an archive is undone before the deadline. */
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
 * Both sources for a bookmark, with the derived accessor the reading view uses:
 * extracted wins when present, because it only exists when `get_text` came back
 * truncated.
 */
export async function readBestText(id: number): Promise<ArticleTextRecord | undefined> {
  const rows = await (await getDb()).getAllFromIndex('article_text', 'by_bookmark', id);
  return rows.find((r) => r.source === 'extracted') ?? rows.find((r) => r.source === 'instapaper');
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
