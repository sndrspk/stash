/**
 * Upgrading a database that already exists on someone's phone.
 *
 * `upgrade` runs once with whatever version the device happens to be on, and for a
 * browser cache that is *any* version this app has ever shipped — there is no deploy
 * that migrates everyone at once. So the thing worth testing is not that a fresh
 * database has the right stores, which any smoke test would catch, but that a v1 and
 * a v2 device both arrive at v3 with their rows intact.
 */
import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';
import { openDB } from 'idb';

import { DB_NAME, DB_VERSION, READING_PREFS_KEY, closeDb, getDb } from '../src/lib/db';

const NOW = 1_700_000_000_000;

async function wipe() {
  await closeDb();
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(DB_NAME);
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  });
}

beforeEach(wipe);

/** The v1 schema, exactly as it shipped. */
async function createV1() {
  const db = await openDB(DB_NAME, 1, {
    upgrade(database) {
      const bookmarks = database.createObjectStore('bookmarks', { keyPath: 'bookmark_id' });
      bookmarks.createIndex('by_state', 'state');
      bookmarks.createIndex('by_time', 'time');
      bookmarks.createIndex('by_purge_after', 'purge_after');

      const text = database.createObjectStore('article_text', { keyPath: 'key' });
      text.createIndex('by_bookmark', 'bookmark_id');
      text.createIndex('by_purge_after', 'purge_after');

      const images = database.createObjectStore('image_cache', { keyPath: 'url' });
      images.createIndex('by_status', 'status');
      images.createIndex('by_purge_after', 'purge_after');
    },
  });
  await db.put('bookmarks', {
    bookmark_id: 7,
    title: 'An article from before the upgrade',
    url: 'https://publisher.example/story',
    time: 1000,
    description: '',
    hash: 'h7',
    folder: 'unread',
    state: 'unread',
    synced_at: 0,
    purge_after: null,
  });
  db.close();
}

/** v1 plus the `settings` store. */
async function createV2() {
  await createV1();
  const db = await openDB(DB_NAME, 2, {
    upgrade(database) {
      database.createObjectStore('settings');
    },
  });
  await db.put('settings', { font: 'crimson', fontSize: 1.25 }, READING_PREFS_KEY);
  db.close();
}

describe('upgrading to the current version', () => {
  it('takes a v1 device all the way, keeping its bookmarks', async () => {
    await createV1();

    const db = await getDb();
    expect(db.version).toBe(DB_VERSION);
    expect((await db.get('bookmarks', 7))?.title).toBe('An article from before the upgrade');
    // Both later blocks ran, not just the last one.
    expect([...db.objectStoreNames]).toContain('settings');
    expect([...db.objectStoreNames]).toContain('pending_actions');
  });

  it('takes a v2 device the last step, keeping its preferences', async () => {
    // The common case at this release: everyone who has opened the app since Phase 6.
    await createV2();

    const db = await getDb();
    expect(db.version).toBe(DB_VERSION);
    expect(await db.get('settings', READING_PREFS_KEY)).toMatchObject({ font: 'crimson' });
    expect((await db.get('bookmarks', 7))?.title).toBe('An article from before the upgrade');
    expect([...db.objectStoreNames]).toContain('pending_actions');
  });

  it('gives a fresh device every store in one go', async () => {
    const db = await getDb();
    expect(db.version).toBe(DB_VERSION);
    expect([...db.objectStoreNames].sort()).toEqual([
      'article_text',
      'bookmarks',
      'image_cache',
      'pending_actions',
      'settings',
    ]);
  });

  it('indexes the queue by when it was filled', async () => {
    // The replay order depends on this index existing, and an index missed by a
    // migration fails at the first flush rather than at the upgrade.
    const db = await getDb();
    await db.put('pending_actions', {
      bookmark_id: 1,
      action: 'archive',
      queued_at: NOW,
      attempts: 0,
      last_error: null,
    });
    expect(await db.getAllFromIndex('pending_actions', 'by_queued_at')).toHaveLength(1);
  });
});
