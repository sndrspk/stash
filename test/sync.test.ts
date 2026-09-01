import { describe, expect, it } from 'vitest';

import type { BookmarkRecord } from '../src/lib/db';
import { parseBookmarkList, reconcile, type RemoteBookmark } from '../src/lib/sync';

const NOW = 1_700_000_000_000;

const local = (id: number, state: BookmarkRecord['state'] = 'unread'): BookmarkRecord => ({
  bookmark_id: id,
  title: `Local ${id}`,
  url: `https://example.com/${id}`,
  time: 1000 + id,
  description: '',
  hash: 'old',
  folder: 'unread',
  state,
  synced_at: 0,
  purge_after: null,
});

const remote = (id: number, over: Partial<RemoteBookmark> = {}): RemoteBookmark => ({
  bookmark_id: id,
  title: `Remote ${id}`,
  url: `https://example.com/${id}`,
  time: 2000 + id,
  description: 'desc',
  hash: 'new',
  ...over,
});

/*
 * The object form is what Instapaper actually sent on the first real call, and
 * what an earlier version of this parser silently returned [] for — so every sync
 * reported an empty unread folder. These tests existed and passed throughout,
 * because they only asserted the array form. So did the Phase 3 browser run,
 * against a stub written to the same assumption.
 *
 * Both shapes are now covered, and the object cases come first because that is the
 * one that met reality.
 */
describe('parseBookmarkList — object form', () => {
  it('finds bookmarks under a bookmarks key', () => {
    const parsed = parseBookmarkList({
      user: { user_id: 1, username: 'reader' },
      bookmarks: [
        { bookmark_id: 10, title: 'A', url: 'https://a', time: 5, hash: 'h' },
        { bookmark_id: 11, title: 'B', url: 'https://b', time: 6, hash: 'i' },
      ],
      highlights: [],
      delete_ids: [],
    });
    expect(parsed.map((b) => b.bookmark_id)).toEqual([10, 11]);
    expect(parsed[0]?.title).toBe('A');
  });

  it('does not require entries to carry type: bookmark', () => {
    // In the object form they sit under their own key and carry no type at all.
    // Requiring the tag is what made this return nothing.
    expect(parseBookmarkList({ bookmarks: [{ bookmark_id: 7 }] })).toHaveLength(1);
  });

  it('is not fooled by other arrays in the object', () => {
    // delete_ids and highlights are arrays too, and would win by position if the
    // parser just took the first one it found.
    const parsed = parseBookmarkList({
      delete_ids: [101, 102, 103],
      highlights: [{ highlight_id: 5, text: 'x' }],
      bookmarks: [{ bookmark_id: 42 }],
    });
    expect(parsed.map((b) => b.bookmark_id)).toEqual([42]);
  });

  it('falls back to any array that looks like bookmarks', () => {
    // So an upstream key rename degrades into working rather than into an empty
    // queue, which is the failure mode that cost this phase a round trip.
    const parsed = parseBookmarkList({
      user: { user_id: 1 },
      items: [{ bookmark_id: 99, title: 'Renamed key' }],
    });
    expect(parsed.map((b) => b.bookmark_id)).toEqual([99]);
  });

  it('returns nothing for an object with no bookmarks anywhere', () => {
    expect(parseBookmarkList({ user: { user_id: 1 }, bookmarks: [] })).toEqual([]);
    expect(parseBookmarkList({ delete_ids: [1, 2] })).toEqual([]);
  });

  it('excludes non-bookmark entries that share the array', () => {
    const parsed = parseBookmarkList({
      bookmarks: [
        { type: 'user', user_id: 1, bookmark_id: 999 },
        { type: 'error', error_code: 1040, bookmark_id: 998 },
        { bookmark_id: 5 },
      ],
    });
    expect(parsed.map((b) => b.bookmark_id)).toEqual([5]);
  });
});

describe('parseBookmarkList', () => {
  it('picks bookmarks out of a heterogeneous response', () => {
    const parsed = parseBookmarkList([
      { type: 'user', user_id: 1, username: 'reader' },
      { type: 'bookmark', bookmark_id: 10, title: 'A', url: 'https://a', time: 5, hash: 'h' },
      { type: 'folder', folder_id: 'unread' },
    ]);
    expect(parsed).toHaveLength(1);
    expect(parsed[0]?.bookmark_id).toBe(10);
    expect(parsed[0]?.title).toBe('A');
  });

  it('defaults missing string and number fields rather than yielding undefined', () => {
    const [only] = parseBookmarkList([{ type: 'bookmark', bookmark_id: 7 }]);
    expect(only).toEqual({
      bookmark_id: 7,
      title: '',
      url: '',
      time: 0,
      description: '',
      hash: '',
    });
  });

  it('accepts a string id', () => {
    expect(parseBookmarkList([{ type: 'bookmark', bookmark_id: '42' }])[0]?.bookmark_id).toBe(42);
  });

  it('skips entries with no usable id', () => {
    // A row keyed on 0 or NaN would collide with every other malformed row, so
    // these are dropped rather than coerced.
    expect(
      parseBookmarkList([
        { type: 'bookmark' },
        { type: 'bookmark', bookmark_id: 0 },
        { type: 'bookmark', bookmark_id: -3 },
        { type: 'bookmark', bookmark_id: 'nonsense' },
        { type: 'bookmark', bookmark_id: null },
      ]),
    ).toEqual([]);
  });

  it('survives shapes that are not a bookmark list at all', () => {
    for (const raw of [null, undefined, {}, 'string', 42, [null], [undefined], [[]]]) {
      expect(() => parseBookmarkList(raw)).not.toThrow();
      expect(parseBookmarkList(raw)).toEqual([]);
    }
  });

  it('ignores an error object in the response', () => {
    expect(parseBookmarkList([{ type: 'error', error_code: 1040, message: 'Rate limit' }])).toEqual(
      [],
    );
  });
});

describe('reconcile', () => {
  it('inserts bookmarks that are new', () => {
    const { upserts, gone } = reconcile([], [remote(1), remote(2)], NOW);
    expect(upserts.map((r) => r.bookmark_id)).toEqual([1, 2]);
    expect(gone).toEqual([]);
  });

  it('overwrites local fields with the remote values', () => {
    const { upserts } = reconcile([local(1)], [remote(1, { title: 'Updated' })], NOW);
    expect(upserts[0]?.title).toBe('Updated');
    expect(upserts[0]?.hash).toBe('new');
    expect(upserts[0]?.synced_at).toBe(NOW);
    expect(upserts[0]?.state).toBe('unread');
  });

  it('marks an unread row the remote list omits as gone, not deleted', () => {
    // The central rule: dropping rows on absence makes the cache only as
    // trustworthy as the last response.
    const { upserts, gone } = reconcile([local(1), local(2)], [remote(1)], NOW);
    expect(upserts.map((r) => r.bookmark_id)).toEqual([1]);
    expect(gone).toEqual([2]);
  });

  it('leaves archived and deleted rows alone when absent', () => {
    // Their absence is the expected consequence of our own action, not news.
    const { gone } = reconcile([local(1, 'archived'), local(2, 'deleted')], [], NOW);
    expect(gone).toEqual([]);
  });

  it('does not re-mark a row already gone', () => {
    const { gone } = reconcile([local(1, 'gone')], [], NOW);
    expect(gone).toEqual([]);
  });

  it('restores a gone row that reappears', () => {
    const { upserts } = reconcile([local(1, 'gone')], [remote(1)], NOW);
    expect(upserts[0]?.state).toBe('unread');
  });

  it('clears purge_after on anything the remote list still has', () => {
    // This is what makes an undone archive keep its cached text: the article comes
    // back before the grace period expires and the mark is lifted.
    const archived = { ...local(1, 'archived'), purge_after: NOW + 1000 };
    const { upserts } = reconcile([archived], [remote(1)], NOW);
    expect(upserts[0]?.purge_after).toBeNull();
    expect(upserts[0]?.state).toBe('unread');
  });

  it('marks everything gone for an empty remote list', () => {
    // Alarming but correct: zero unread is a real state, nothing is destroyed, and
    // a later sync restores every row. Nothing in the response distinguishes a
    // genuine empty queue from a bad one, so guessing would only make failure
    // quieter, not rarer.
    const { upserts, gone } = reconcile([local(1), local(2), local(3)], [], NOW);
    expect(upserts).toEqual([]);
    expect(gone).toEqual([1, 2, 3]);
  });

  it('handles both lists being empty', () => {
    expect(reconcile([], [], NOW)).toEqual({ upserts: [], gone: [] });
  });
});
