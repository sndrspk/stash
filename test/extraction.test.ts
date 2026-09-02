// A real IndexedDB: the gating reads and writes the same rows the reading view does.
import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import { closeDb, type BookmarkRecord } from '../src/lib/db';
import {
  RETRY_AFTER_MS,
  extractArticle,
  needsExtraction,
  resetExtractionLocks,
  type ExtractOutcome,
} from '../src/lib/extraction';
import { bestOf, readBestText, readText, writeText } from '../src/lib/store';

const NOW = 1_700_000_000_000;

/** Long enough not to trip the truncation heuristic. */
const FULL = `<p>${'Real article prose, at length, so the heuristic is satisfied. '.repeat(40)}</p>`;
const STUB = '<p>Read more</p>';

const bookmark = (over: Partial<BookmarkRecord> = {}): BookmarkRecord => ({
  bookmark_id: 1,
  title: 'An article',
  url: 'https://publisher.example/story',
  time: 1000,
  description: 'A summary from Instapaper.',
  hash: 'h1',
  folder: 'unread',
  state: 'unread',
  synced_at: 0,
  purge_after: null,
  ...over,
});

beforeEach(async () => {
  resetExtractionLocks();
  await closeDb();
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase('stash');
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  });
});

/** A fetcher that answers from a table and records what it was asked. */
function recording(outcome: ExtractOutcome = { kind: 'extracted', html: FULL, truncated: false }) {
  const asked: string[] = [];
  return {
    asked,
    fetchExtract: (url: string) => {
      asked.push(url);
      return Promise.resolve(outcome);
    },
  };
}

describe('needsExtraction', () => {
  it('is true for a stub, and for nothing at all', () => {
    expect(needsExtraction(STUB)).toBe(true);
    expect(needsExtraction('')).toBe(true);
    expect(needsExtraction(undefined)).toBe(true);
  });

  it('is false for a full article', () => {
    expect(needsExtraction(FULL)).toBe(false);
  });
});

describe('the gate', () => {
  it('extracts when Instapaper returned a stub', async () => {
    await writeText(1, 'instapaper', STUB, NOW);
    const { asked, fetchExtract } = recording();

    const result = await extractArticle(bookmark(), { fetchExtract, now: () => NOW });

    expect(asked).toEqual(['https://publisher.example/story']);
    expect(result.outcome).toMatchObject({ kind: 'extracted' });
  });

  it('does not extract when Instapaper returned a full article', async () => {
    // The rule that keeps this from being a crawler: a good article is never
    // re-fetched because a publisher is on some list.
    await writeText(1, 'instapaper', FULL, NOW);
    const { asked, fetchExtract } = recording();

    const result = await extractArticle(bookmark(), { fetchExtract, now: () => NOW });

    expect(asked).toEqual([]);
    expect(result.skipped).toBe('not-truncated');
  });

  it('does not re-extract an article it already has', async () => {
    await writeText(1, 'instapaper', STUB, NOW);
    await writeText(1, 'extracted', FULL, NOW);
    const { asked, fetchExtract } = recording();

    expect((await extractArticle(bookmark(), { fetchExtract, now: () => NOW })).skipped).toBe(
      'already-extracted',
    );
    expect(asked).toEqual([]);
  });

  it('does nothing for a bookmark with no URL', async () => {
    const { asked, fetchExtract } = recording();
    const result = await extractArticle(bookmark({ url: '' }), { fetchExtract });

    expect(result.skipped).toBe('no-url');
    expect(asked).toEqual([]);
  });
});

describe('the retry backoff', () => {
  it('records a failure rather than dropping it', async () => {
    // A failure nobody wrote down is a failure retried on every open.
    await writeText(1, 'instapaper', STUB, NOW);
    const { fetchExtract } = recording({ kind: 'failed', tag: 'HTTP 403' });

    const result = await extractArticle(bookmark(), { fetchExtract, now: () => NOW });

    expect(result.outcome).toMatchObject({ kind: 'failed', tag: 'HTTP 403' });
    expect((await readText(1, 'extracted'))?.html).toBe('');
  });

  it('holds off for a week after a failure', async () => {
    await writeText(1, 'instapaper', STUB, NOW);
    await writeText(1, 'extracted', '', NOW);
    const { asked, fetchExtract } = recording();

    expect(
      (await extractArticle(bookmark(), { fetchExtract, now: () => NOW + RETRY_AFTER_MS - 1 }))
        .skipped,
    ).toBe('backoff');
    expect(asked).toEqual([]);
  });

  it('tries again once the week is up', async () => {
    await writeText(1, 'instapaper', STUB, NOW);
    await writeText(1, 'extracted', '', NOW);
    const { asked, fetchExtract } = recording();

    await extractArticle(bookmark(), { fetchExtract, now: () => NOW + RETRY_AFTER_MS });
    expect(asked).toHaveLength(1);
  });

  it('is a comparison, not a filter — which is what lets force override it', async () => {
    /*
     * The spec is specific about the placement: expressed as a query filter, the
     * row is simply absent and an explicit "fetch this now" has nothing to act on.
     */
    await writeText(1, 'instapaper', STUB, NOW);
    await writeText(1, 'extracted', '', NOW);
    const { asked, fetchExtract } = recording();

    const result = await extractArticle(bookmark(), {
      fetchExtract,
      force: true,
      now: () => NOW + 1000,
    });

    expect(asked).toHaveLength(1);
    expect(result.outcome).toMatchObject({ kind: 'extracted' });
  });
});

describe('an explicit request', () => {
  it('bypasses the truncation gate', async () => {
    // "Fetch full content" is a decision, not a hint.
    await writeText(1, 'instapaper', FULL, NOW);
    const { asked, fetchExtract } = recording();

    await extractArticle(bookmark(), { fetchExtract, force: true, now: () => NOW });
    expect(asked).toHaveLength(1);
  });

  it('re-extracts an article that already has one', async () => {
    await writeText(1, 'extracted', '<p>An older extraction.</p>', NOW);
    const { asked, fetchExtract } = recording();

    await extractArticle(bookmark(), { fetchExtract, force: true, now: () => NOW });
    expect(asked).toHaveLength(1);
    expect((await readText(1, 'extracted'))?.html).toBe(FULL);
  });
});

describe('store beside, never over', () => {
  it('leaves the Instapaper text exactly as it was', async () => {
    await writeText(1, 'instapaper', STUB, NOW);
    const { fetchExtract } = recording();

    await extractArticle(bookmark(), { fetchExtract, now: () => NOW });

    expect((await readText(1, 'instapaper'))?.html).toBe(STUB);
    expect((await readText(1, 'extracted'))?.html).toBe(FULL);
  });

  it('shows the extracted copy once there is one', async () => {
    await writeText(1, 'instapaper', STUB, NOW);
    const { fetchExtract } = recording();

    await extractArticle(bookmark(), { fetchExtract, now: () => NOW });
    expect((await readBestText(1))?.source).toBe('extracted');
  });

  it('never shows a failed extraction in place of a real article', async () => {
    /*
     * The trap in recording failures as empty rows: a naive "extracted ?? instapaper"
     * answers a perfectly good article with a blank screen, and does it precisely
     * for the articles where extraction was needed and did not work.
     */
    await writeText(1, 'instapaper', FULL, NOW);
    await writeText(1, 'extracted', '', NOW);

    const best = await readBestText(1);
    expect(best?.source).toBe('instapaper');
    expect(best?.html).toBe(FULL);
  });

  it('is the same rule wherever it is asked', () => {
    const rows = [
      {
        key: '1:extracted',
        bookmark_id: 1,
        source: 'extracted' as const,
        html: '',
        fetched_at: 0,
        purge_after: null,
      },
      {
        key: '1:instapaper',
        bookmark_id: 1,
        source: 'instapaper' as const,
        html: FULL,
        fetched_at: 0,
        purge_after: null,
      },
    ];
    expect(bestOf(rows)?.source).toBe('instapaper');
    expect(bestOf([{ ...rows[0]!, html: FULL }, rows[1]!])?.source).toBe('extracted');
  });
});

describe('single-flight', () => {
  it('skips an overlapping attempt on the same article', async () => {
    /*
     * Queued would be wrong here, unlike the image and text passes: two extraction
     * attempts are about the article a reader just opened, so the second has
     * nothing to add and would double the load on a publisher for one page view.
     */
    await writeText(1, 'instapaper', STUB, NOW);
    const asked: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const fetchExtract = async (url: string): Promise<ExtractOutcome> => {
      asked.push(url);
      await gate;
      return { kind: 'extracted', html: FULL, truncated: false };
    };

    // No await between the two calls: the lock is taken synchronously, before any
    // of the gates, which is the only way a try-lock can actually hold.
    const first = extractArticle(bookmark(), { fetchExtract, now: () => NOW });
    const second = await extractArticle(bookmark(), { fetchExtract, now: () => NOW });

    expect(second.skipped).toBe('in-flight');
    release?.();
    await first;
    expect(asked).toHaveLength(1);
  });

  it('locks per article, not globally', async () => {
    await writeText(1, 'instapaper', STUB, NOW);
    await writeText(2, 'instapaper', STUB, NOW);
    const { asked, fetchExtract } = recording();

    await Promise.all([
      extractArticle(bookmark({ bookmark_id: 1 }), { fetchExtract, now: () => NOW }),
      extractArticle(bookmark({ bookmark_id: 2, url: 'https://other.example/x' }), {
        fetchExtract,
        now: () => NOW,
      }),
    ]);

    expect(asked).toHaveLength(2);
  });

  it('releases the lock when the fetch throws', async () => {
    await writeText(1, 'instapaper', STUB, NOW);

    await expect(
      extractArticle(bookmark(), {
        fetchExtract: () => Promise.reject(new Error('offline')),
        now: () => NOW,
      }),
    ).rejects.toThrow('offline');

    const { asked, fetchExtract } = recording();
    await extractArticle(bookmark(), { fetchExtract, now: () => NOW });
    expect(asked).toHaveLength(1);
  });
});

describe('a refusal', () => {
  it('is recorded like any other failure', async () => {
    await writeText(1, 'instapaper', STUB, NOW);
    const { fetchExtract } = recording({
      kind: 'blocked',
      tag: 'instapaper.com must never be fetched',
    });

    const result = await extractArticle(bookmark(), { fetchExtract, now: () => NOW });

    expect(result.outcome).toMatchObject({ kind: 'blocked' });
    expect((await readText(1, 'extracted'))?.html).toBe('');
  });
});
