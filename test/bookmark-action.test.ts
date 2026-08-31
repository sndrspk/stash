import { describe, expect, it } from 'vitest';

import { parseBookmarkId } from '../src/lib/bookmark-action';

/*
 * The absence of a batch endpoint is a design decision, not an oversight: these
 * calls reach into a real Instapaper account and delete is irreversible there. A
 * batch endpoint turns a UI bug into a hundred lost articles instead of one.
 *
 * So it is enforced rather than merely intended, and these are the assertions that
 * do the enforcing.
 */
describe('parseBookmarkId', () => {
  it('accepts one positive integer id', () => {
    expect(parseBookmarkId({ bookmark_id: 12345 })).toBe(12345);
  });

  it('accepts a numeric string, since ids arrive both ways', () => {
    expect(parseBookmarkId({ bookmark_id: '12345' })).toBe(12345);
  });

  it('refuses an array of ids', () => {
    // The shape a caller would send if it assumed batching. It must not quietly
    // become the first element, or a loop.
    expect(parseBookmarkId({ bookmark_id: [1, 2, 3] })).toBeNull();
    expect(parseBookmarkId([{ bookmark_id: 1 }, { bookmark_id: 2 }])).toBeNull();
    expect(parseBookmarkId([1, 2, 3])).toBeNull();
  });

  it('refuses ids that are not positive integers', () => {
    for (const value of [0, -1, 1.5, NaN, Infinity, '', 'abc', null, undefined, {}, true]) {
      expect(parseBookmarkId({ bookmark_id: value }), String(value)).toBeNull();
    }
  });

  it('refuses a body with no id at all', () => {
    for (const body of [{}, null, undefined, 'string', 42]) {
      expect(parseBookmarkId(body), String(body)).toBeNull();
    }
  });

  it('ignores extra fields rather than failing on them', () => {
    // Forwards-compatible: a client sending more context should still work.
    expect(parseBookmarkId({ bookmark_id: 7, folder: 'unread', why: 'read it' })).toBe(7);
  });
});
