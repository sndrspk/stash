// A real IndexedDB implementation, so these exercise transactions, indexes and key
// ranges rather than a hand-written stand-in that would agree with my assumptions.
import 'fake-indexeddb/auto';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { IMAGE_RETRY_MS, PURGE_GRACE_MS, closeDb, getDb, textKey } from '../src/lib/db';
import {
  markLocally,
  needsImageLookup,
  purgeExpired,
  readBestText,
  readUnread,
  restore,
  unmarkPurge,
  writeImage,
  writeText,
  applySync,
} from '../src/lib/store';
import type { RemoteBookmark } from '../src/lib/sync';

const NOW = 1_700_000_000_000;

const remote = (id: number, over: Partial<RemoteBookmark> = {}): RemoteBookmark => ({
  bookmark_id: id,
  title: `Article ${id}`,
  url: `https://example.com/${id}`,
  time: 1000 + id,
  description: '',
  hash: `h${id}`,
  ...over,
});

beforeEach(async () => {
  await closeDb();
  // A fresh database per test; deleteDatabase is the only way to reset the schema.
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase('stash');
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  });
});

afterEach(closeDb);

describe('applySync', () => {
  it('writes bookmarks and reads them back newest first', async () => {
    await applySync(
      [remote(1, { time: 100 }), remote(2, { time: 300 }), remote(3, { time: 200 })],
      NOW,
    );
    expect((await readUnread()).map((r) => r.bookmark_id)).toEqual([2, 3, 1]);
  });

  it('marks absentees gone rather than deleting the rows', async () => {
    await applySync([remote(1), remote(2)], NOW);
    const result = await applySync([remote(1)], NOW);

    expect(result).toEqual({ upserted: 1, markedGone: 1 });
    expect((await readUnread()).map((r) => r.bookmark_id)).toEqual([1]);

    // The row survives — that is the whole point of marking.
    const db = await getDb();
    expect((await db.get('bookmarks', 2))?.state).toBe('gone');
  });

  it('restores a gone bookmark when it comes back', async () => {
    await applySync([remote(1)], NOW);
    await applySync([], NOW);
    expect(await readUnread()).toEqual([]);

    await applySync([remote(1)], NOW + 1);
    expect((await readUnread()).map((r) => r.bookmark_id)).toEqual([1]);
  });

  it('is idempotent', async () => {
    await applySync([remote(1), remote(2)], NOW);
    await applySync([remote(1), remote(2)], NOW);
    expect(await readUnread()).toHaveLength(2);
  });
});

describe('markLocally and restore', () => {
  beforeEach(async () => {
    await applySync([remote(1)], NOW);
    await writeText(1, 'instapaper', '<p>original</p>', NOW);
    await writeImage({
      url: 'https://example.com/1',
      image_url: 'https://img/1.jpg',
      status: 'ok',
      resolved_at: NOW,
      purge_after: null,
    });
  });

  it('removes the bookmark from unread and schedules the cache for purging', async () => {
    const snapshot = await markLocally(1, 'archived', NOW);

    expect(snapshot).not.toBeNull();
    expect(await readUnread()).toEqual([]);

    const db = await getDb();
    expect((await db.get('bookmarks', 1))?.purge_after).toBe(NOW + PURGE_GRACE_MS);
    expect((await db.get('article_text', textKey(1, 'instapaper')))?.purge_after).toBe(
      NOW + PURGE_GRACE_MS,
    );
    expect((await db.get('image_cache', 'https://example.com/1'))?.purge_after).toBe(
      NOW + PURGE_GRACE_MS,
    );
  });

  it('puts every touched row back exactly', async () => {
    const db = await getDb();
    const before = {
      bookmark: await db.get('bookmarks', 1),
      text: await db.get('article_text', textKey(1, 'instapaper')),
      image: await db.get('image_cache', 'https://example.com/1'),
    };

    const snapshot = await markLocally(1, 'archived', NOW);
    await restore(snapshot!);

    expect(await db.get('bookmarks', 1)).toEqual(before.bookmark);
    expect(await db.get('article_text', textKey(1, 'instapaper'))).toEqual(before.text);
    expect(await db.get('image_cache', 'https://example.com/1')).toEqual(before.image);
    expect((await readUnread()).map((r) => r.bookmark_id)).toEqual([1]);
  });

  it('returns null for a bookmark that is not there', async () => {
    expect(await markLocally(999, 'archived', NOW)).toBeNull();
  });

  it('unmarkPurge clears the marks and returns the article to unread', async () => {
    await markLocally(1, 'archived', NOW);
    await unmarkPurge(1);

    const db = await getDb();
    expect((await db.get('bookmarks', 1))?.purge_after).toBeNull();
    expect((await db.get('article_text', textKey(1, 'instapaper')))?.purge_after).toBeNull();
    expect((await readUnread()).map((r) => r.bookmark_id)).toEqual([1]);
  });
});

describe('purgeExpired', () => {
  it('drops exactly the rows past their grace period and no others', async () => {
    // The phase's "done when", stated as a test. Three articles: one archived long
    // ago, one archived just now, one never archived.
    await applySync([remote(1), remote(2), remote(3)], NOW);
    for (const id of [1, 2, 3]) await writeText(id, 'instapaper', `<p>${id}</p>`, NOW);

    await markLocally(1, 'archived', NOW - PURGE_GRACE_MS - 1);
    await markLocally(2, 'archived', NOW);

    const result = await purgeExpired(NOW);

    expect(result.texts).toBe(1);
    const db = await getDb();
    expect(await db.get('article_text', textKey(1, 'instapaper'))).toBeUndefined();
    expect(await db.get('article_text', textKey(2, 'instapaper'))).toBeDefined();
    expect(await db.get('article_text', textKey(3, 'instapaper'))).toBeDefined();
  });

  it('never touches a row with no purge mark', async () => {
    await applySync([remote(1)], NOW);
    await writeText(1, 'instapaper', '<p>keep</p>', NOW);

    // Far future: a null purge_after must still be excluded, not treated as zero.
    expect(await purgeExpired(NOW + 10 ** 12)).toEqual({ texts: 0, images: 0 });
    expect(await readBestText(1)).toBeDefined();
  });

  it('does not purge exactly at the deadline, only past it', async () => {
    await applySync([remote(1)], NOW);
    await writeText(1, 'instapaper', '<p>x</p>', NOW);
    await markLocally(1, 'archived', NOW);

    const deadline = NOW + PURGE_GRACE_MS;
    expect((await purgeExpired(deadline)).texts).toBe(0);
    expect((await purgeExpired(deadline + 1)).texts).toBe(1);
  });

  it('purges images on the same rule', async () => {
    await applySync([remote(1)], NOW);
    await writeImage({
      url: 'https://example.com/1',
      image_url: null,
      status: 'none',
      resolved_at: NOW,
      purge_after: null,
    });
    await markLocally(1, 'archived', NOW - PURGE_GRACE_MS - 1);

    expect((await purgeExpired(NOW)).images).toBe(1);
  });
});

describe('article text', () => {
  it('stores beside, never over', async () => {
    await writeText(1, 'instapaper', '<p>stub</p>', NOW);
    await writeText(1, 'extracted', '<p>full article</p>', NOW);

    const db = await getDb();
    // Both survive: a bad extraction must never destroy what Instapaper returned,
    // and "show original" comes free from having kept it.
    expect((await db.get('article_text', textKey(1, 'instapaper')))?.html).toBe('<p>stub</p>');
    expect((await db.get('article_text', textKey(1, 'extracted')))?.html).toBe(
      '<p>full article</p>',
    );
  });

  it('prefers the extracted copy when both exist', async () => {
    await writeText(1, 'instapaper', '<p>stub</p>', NOW);
    await writeText(1, 'extracted', '<p>full</p>', NOW);
    expect((await readBestText(1))?.source).toBe('extracted');
  });

  it('falls back to the Instapaper copy alone', async () => {
    await writeText(1, 'instapaper', '<p>stub</p>', NOW);
    expect((await readBestText(1))?.source).toBe('instapaper');
  });

  it('returns undefined when there is nothing', async () => {
    expect(await readBestText(999)).toBeUndefined();
  });
});

describe('needsImageLookup', () => {
  const row = (status: 'ok' | 'none' | 'error') => ({
    url: 'https://example.com/x',
    image_url: status === 'ok' ? 'https://img/x.jpg' : null,
    status,
    resolved_at: NOW,
    purge_after: null,
  });

  it('is true for a URL never looked up', async () => {
    expect(await needsImageLookup('https://example.com/never')).toBe(true);
  });

  it('is false once resolved', async () => {
    await writeImage(row('ok'));
    expect(await needsImageLookup('https://example.com/x')).toBe(false);
  });

  it('is false for a negative result, permanently', async () => {
    // The rule that keeps a first sync from becoming a standing tax: a page with no
    // image will still have none tomorrow.
    await writeImage(row('none'));
    expect(await needsImageLookup('https://example.com/x')).toBe(false);
  });

  it('is true after an error, which may be transient', async () => {
    await writeImage(row('error'));
    expect(await needsImageLookup('https://example.com/x')).toBe(true);
  });

  it('is false while an error is still inside the retry interval', async () => {
    // "May be retried" and "is retried on every sync" are different rules, and only
    // the first one is kind to a site that happened to be down when we asked.
    await writeImage(row('error'));
    expect(await needsImageLookup('https://example.com/x', NOW + IMAGE_RETRY_MS - 1)).toBe(false);
    expect(await needsImageLookup('https://example.com/x', NOW + IMAGE_RETRY_MS)).toBe(true);
  });
});
