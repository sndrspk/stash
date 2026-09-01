import { describe, expect, it } from 'vitest';

import { describeResponse } from '../src/lib/fixtures';

/*
 * The first real `bookmarks/list` call against an account returned nothing, and
 * the script announced "The unread folder is empty". That was a conclusion, not
 * an observation: an empty folder and a response we failed to parse are
 * indistinguishable from where the script stands, and asserting the first sends
 * someone looking in entirely the wrong place.
 *
 * So it now reports the shape. These pin what it may and may not say.
 */
describe('describeResponse', () => {
  it('distinguishes an empty array from a response of the wrong type', () => {
    expect(describeResponse([])).toContain('empty array');
    expect(describeResponse(null)).toContain('null');
    expect(describeResponse({})).toContain('object');
    expect(describeResponse('a string')).toContain('string');
  });

  it('tallies entry types so a parser fault is visible', () => {
    // If this shows bookmark entries while zero were parsed, the parser is wrong
    // and the folder is fine — which is the whole distinction being drawn.
    const summary = describeResponse([
      { type: 'user', user_id: 1 },
      { type: 'bookmark', bookmark_id: 1 },
      { type: 'bookmark', bookmark_id: 2 },
    ]);
    expect(summary).toContain('3 entries');
    expect(summary).toContain('2 × bookmark');
    expect(summary).toContain('1 × user');
  });

  it('names an entry with no type field rather than skipping it', () => {
    expect(describeResponse([{ bookmark_id: 1 }])).toContain('(no type field)');
  });

  it('handles entries that are not objects', () => {
    expect(describeResponse([null, 'x', 42])).toContain('3 entries');
  });

  it('surfaces an error response, which is the other way to get nothing', () => {
    const summary = describeResponse([{ type: 'error', error_code: 1040 }]);
    expect(summary).toContain('1 × error');
  });

  it('echoes no content from the response', () => {
    // A diagnostic has no business printing titles or URLs to a terminal, still
    // less into a bug report. Only shape and counts.
    const summary = describeResponse([
      {
        type: 'bookmark',
        bookmark_id: 99,
        title: 'A private headline',
        url: 'https://publisher.example/secret',
      },
    ]);
    expect(summary).not.toContain('private');
    expect(summary).not.toContain('publisher.example');
    expect(summary).not.toContain('99');
  });
});
