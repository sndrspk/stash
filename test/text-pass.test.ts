// A real IndexedDB, so the skip rule is asserted against the store it reads.
import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import { ApiError } from '../src/lib/api-error';
import { closeDb } from '../src/lib/db';
import type { BookmarkRecord } from '../src/lib/db';
import { readText, writeText } from '../src/lib/store';
import { ensureText, resetTextPass } from '../src/lib/text';

const NOW = 1_700_000_000_000;

const bookmark = (id: number): BookmarkRecord => ({
  bookmark_id: id,
  title: `Article ${id}`,
  url: `https://example.com/${id}`,
  time: 1000 + id,
  description: '',
  hash: `h${id}`,
  folder: 'unread',
  state: 'unread',
  synced_at: 0,
  purge_after: null,
});

beforeEach(async () => {
  resetTextPass();
  await closeDb();
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase('stash');
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  });
});

/** A fetcher that answers from a table and records what it was asked. */
function recording(answers: Record<number, 'empty' | 'failed' | string> = {}) {
  const asked: number[] = [];
  const fetchText = (id: number) => {
    asked.push(id);
    const answer = answers[id] ?? `<p>Article ${id}.</p>`;
    if (answer === 'empty') return Promise.resolve({ kind: 'empty' as const });
    if (answer === 'failed') return Promise.resolve({ kind: 'failed' as const });
    return Promise.resolve({ kind: 'html' as const, html: answer });
  };
  return { asked, fetchText };
}

describe('a first pass', () => {
  it('fetches and caches each article', async () => {
    const { asked, fetchText } = recording();
    const result = await ensureText([bookmark(1), bookmark(2)], { fetchText, now: () => NOW });

    expect(asked).toEqual([1, 2]);
    expect(result).toMatchObject({ requested: 2, skipped: 0, fetched: 2, failed: 0 });
    expect((await readText(1, 'instapaper'))?.html).toBe('<p>Article 1.</p>');
  });

  it('asks once for a bookmark listed twice', async () => {
    const { asked, fetchText } = recording();
    await ensureText([bookmark(1), bookmark(1)], { fetchText });
    expect(asked).toEqual([1]);
  });

  it('caches "Instapaper has no text for this" as an empty row', async () => {
    // Otherwise every refresh re-derives the same answer at the cost of a call.
    const { fetchText } = recording({ 1: 'empty' });
    const result = await ensureText([bookmark(1)], { fetchText });

    expect(result).toMatchObject({ fetched: 0, empty: 1, failed: 0 });
    expect((await readText(1, 'instapaper'))?.html).toBe('');
  });

  it('writes nothing for a failure, so it is tried again', async () => {
    // The opposite of the image rule, deliberately: an empty string cached as text
    // would make the reading view show a blank article rather than try again.
    const { fetchText } = recording({ 1: 'failed' });
    const result = await ensureText([bookmark(1)], { fetchText });

    expect(result).toMatchObject({ fetched: 0, failed: 1 });
    expect(await readText(1, 'instapaper')).toBeUndefined();

    resetTextPass();
    const retry = recording();
    await ensureText([bookmark(1)], { fetchText: retry.fetchText });
    expect(retry.asked).toEqual([1]);
  });
});

describe('the second pass', () => {
  it('asks for nothing that is already cached', async () => {
    await writeText(1, 'instapaper', '<p>Already here.</p>', NOW);

    const { asked, fetchText } = recording();
    const result = await ensureText([bookmark(1), bookmark(2)], { fetchText });

    expect(asked).toEqual([2]);
    expect(result).toMatchObject({ requested: 2, skipped: 1, fetched: 1 });
  });

  it('makes no requests at all when every slot article has its text', async () => {
    const first = recording();
    await ensureText([bookmark(1), bookmark(2)], { fetchText: first.fetchText });
    expect(first.asked).toHaveLength(2);

    resetTextPass();
    const second = recording();
    const result = await ensureText([bookmark(1), bookmark(2)], { fetchText: second.fetchText });

    expect(second.asked).toEqual([]);
    expect(result).toMatchObject({ skipped: 2, fetched: 0 });
  });

  it('treats a cached empty row as an answer, not as a gap to fill', async () => {
    await writeText(1, 'instapaper', '', NOW);
    const { asked, fetchText } = recording();

    await ensureText([bookmark(1)], { fetchText });
    expect(asked).toEqual([]);
  });
});

describe('an expired gate', () => {
  it('stops the pass rather than caching the refusal as missing text', async () => {
    await expect(
      ensureText([bookmark(1), bookmark(2)], {
        fetchText: () => Promise.reject(new ApiError(401, 'unauthorized')),
      }),
    ).rejects.toBeInstanceOf(ApiError);

    expect(await readText(1, 'instapaper')).toBeUndefined();
    expect(await readText(2, 'instapaper')).toBeUndefined();
  });
});

describe('overlapping passes', () => {
  it('queues rather than racing, so nothing is fetched twice', async () => {
    // Each refresh reshuffles the slots, so the second pass is usually about
    // different articles — skipping it outright would lose them.
    const { asked, fetchText } = recording();

    const [first, second] = await Promise.all([
      ensureText([bookmark(1)], { fetchText }),
      ensureText([bookmark(1), bookmark(2)], { fetchText }),
    ]);

    expect(asked).toEqual([1, 2]);
    expect(first).toMatchObject({ fetched: 1 });
    expect(second).toMatchObject({ skipped: 1, fetched: 1 });
  });

  it('does not let a failed pass strand the one behind it', async () => {
    const { asked, fetchText } = recording();

    const failing = ensureText([bookmark(1)], {
      fetchText: () => Promise.reject(new ApiError(401, 'unauthorized')),
    });
    const following = ensureText([bookmark(2)], { fetchText });

    await expect(failing).rejects.toBeInstanceOf(ApiError);
    await expect(following).resolves.toMatchObject({ fetched: 1 });
    expect(asked).toEqual([2]);
  });
});

describe('nothing to do', () => {
  it('returns an empty result for an empty list', async () => {
    const { asked, fetchText } = recording();
    expect(await ensureText([], { fetchText })).toMatchObject({ requested: 0 });
    expect(asked).toEqual([]);
  });
});
