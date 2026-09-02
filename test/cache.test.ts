// A real IndexedDB: what "clear" leaves behind is the whole point, and only the real
// stores can show it.
import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import { DEFAULT_PREFS } from '../src/lib/prefs';
import { closeDb, getDb, type BookmarkRecord } from '../src/lib/db';
import {
  clearCache,
  queueAction,
  readCacheUsage,
  readPending,
  readPrefs,
  readUnread,
  writeImage,
  writePrefs,
  writeText,
} from '../src/lib/store';

const NOW = 1_700_000_000_000;

const bookmark = (id: number): BookmarkRecord => ({
  bookmark_id: id,
  title: `Article ${String(id)}`,
  url: `https://publisher.example/story/${String(id)}`,
  time: 1000 + id,
  description: '',
  hash: `h${String(id)}`,
  folder: 'unread',
  state: 'unread',
  synced_at: 0,
  purge_after: null,
});

beforeEach(async () => {
  await closeDb();
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase('stash');
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  });
});

/** A cache with something of every kind in it. */
async function fill() {
  const db = await getDb();
  for (const id of [1, 2, 3]) await db.put('bookmarks', bookmark(id));

  await writeText(1, 'instapaper', '<p>One.</p>', NOW);
  await writeText(1, 'extracted', '<p>One, extracted.</p>', NOW);
  await writeText(2, 'instapaper', '<p>Two.</p>', NOW);

  await writeImage({
    url: 'https://publisher.example/story/1',
    image_url: 'https://cdn.example/1.jpg',
    status: 'ok',
    resolved_at: NOW,
    purge_after: null,
  });

  await queueAction(3, 'archive', NOW);
  await writePrefs({ ...DEFAULT_PREFS, font: 'crimson', paper: 'mustard' });
}

describe('readCacheUsage', () => {
  it('counts each store, with both text sources counted separately', async () => {
    await fill();

    expect(await readCacheUsage()).toMatchObject({
      bookmarks: 3,
      texts: 3,
      images: 1,
      pending: 1,
    });
  });

  it('is all zeroes on a fresh device rather than throwing', async () => {
    expect(await readCacheUsage()).toMatchObject({
      bookmarks: 0,
      texts: 0,
      images: 0,
      pending: 0,
    });
  });

  it('reports unknown rather than zero when the browser will not say', async () => {
    /*
     * The distinction the screen depends on: null renders as "this browser will not
     * say" and zero would render as "empty". `navigator.storage` is absent in this
     * environment, which is exactly the case being pinned.
     */
    expect((await readCacheUsage()).bytes).toBeNull();
  });
});

describe('clearCache', () => {
  it('drops the text and the images, and says how much', async () => {
    await fill();

    expect(await clearCache()).toEqual({ texts: 3, images: 1 });

    const after = await readCacheUsage();
    expect(after.texts).toBe(0);
    expect(after.images).toBe(0);
  });

  it('leaves the pending queue completely alone', async () => {
    /*
     * The one that matters. A pending action is not cache — it is a decision the
     * reader made that Instapaper has not heard yet — and dropping it would silently
     * un-archive an article at the moment someone was trying to free space.
     */
    await fill();
    await clearCache();

    expect(await readPending()).toHaveLength(1);
    expect((await readPending())[0]).toMatchObject({ bookmark_id: 3, action: 'archive' });
  });

  it('leaves the reading preferences alone', async () => {
    // Nobody clearing a cache is asking to have their typeface reset.
    await fill();
    await clearCache();

    expect(await readPrefs()).toMatchObject({ font: 'crimson', paper: 'mustard' });
  });

  it('leaves the bookmark rows alone', async () => {
    // Tiny, re-synced anyway, and keeping them is what lets an already-archived
    // article be recognised rather than re-fetched if it reappears.
    await fill();
    await clearCache();

    expect(await readUnread()).toHaveLength(3);
  });

  it('is a no-op on an empty cache', async () => {
    expect(await clearCache()).toEqual({ texts: 0, images: 0 });
  });

  it('can be run twice', async () => {
    await fill();
    await clearCache();
    expect(await clearCache()).toEqual({ texts: 0, images: 0 });
  });
});
