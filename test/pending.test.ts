// A real IndexedDB: the queue and the bookmark rows it reverts are the same stores
// the front page reads.
import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import { ApiError } from '../src/lib/api-error';
import { closeDb, type BookmarkRecord } from '../src/lib/db';
import {
  MAX_ATTEMPTS,
  classify,
  flushOnce,
  flushPending,
  resetFlushLock,
} from '../src/lib/pending';
import {
  clearPending,
  markLocally,
  queueAction,
  readBookmark,
  readPending,
  readPendingFor,
  recordAttempt,
} from '../src/lib/store';
import { getDb } from '../src/lib/db';

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

async function seed(...ids: number[]) {
  const db = await getDb();
  for (const id of ids) await db.put('bookmarks', bookmark(id));
}

beforeEach(async () => {
  resetFlushLock();
  await closeDb();
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase('stash');
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  });
});

/** A sender that answers from a table and records what it was asked, in order. */
function recording(answer: (id: number) => Promise<void> = () => Promise.resolve()) {
  const asked: string[] = [];
  return {
    asked,
    send: (action: 'archive' | 'delete', id: number) => {
      asked.push(`${action}:${String(id)}`);
      return answer(id);
    },
  };
}

describe('the queue', () => {
  it('holds one intent per article, last one winning', async () => {
    /*
     * A reader who archives and then deletes the same article offline has changed
     * their mind, not queued two jobs. Replaying both would send Instapaper an
     * archive for something they wanted gone.
     */
    await queueAction(1, 'archive', NOW);
    await queueAction(1, 'delete', NOW + 1000);

    const queued = await readPending();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ bookmark_id: 1, action: 'delete' });
  });

  it('resets the attempt count when the intent changes', async () => {
    // A fresh decision has not failed yet.
    await queueAction(1, 'archive', NOW);
    await recordAttempt(1, 'offline');
    await queueAction(1, 'delete', NOW + 1000);

    expect((await readPendingFor(1))?.attempts).toBe(0);
    expect((await readPendingFor(1))?.last_error).toBeNull();
  });

  it('replays oldest first', async () => {
    await seed(1, 2, 3);
    await queueAction(3, 'archive', NOW + 2000);
    await queueAction(1, 'archive', NOW);
    await queueAction(2, 'delete', NOW + 1000);

    const { asked, send } = recording();
    await flushPending({ send });

    expect(asked).toEqual(['archive:1', 'delete:2', 'archive:3']);
  });

  it('counts attempts atomically, so a racing flush cannot lose one', async () => {
    await queueAction(1, 'archive', NOW);
    const counts = await Promise.all([
      recordAttempt(1, 'a'),
      recordAttempt(1, 'b'),
      recordAttempt(1, 'c'),
    ]);
    expect(counts.sort()).toEqual([1, 2, 3]);
    expect((await readPendingFor(1))?.attempts).toBe(3);
  });

  it('shrugs at an attempt on something already sent', async () => {
    expect(await recordAttempt(99, 'gone')).toBe(0);
  });
});

describe('a successful flush', () => {
  it('sends each action once and empties the queue', async () => {
    await seed(1, 2);
    await queueAction(1, 'archive', NOW);
    await queueAction(2, 'delete', NOW + 1);

    const { asked, send } = recording();
    const result = await flushPending({ send });

    expect(asked).toEqual(['archive:1', 'delete:2']);
    expect(result).toMatchObject({ sent: 2, deferred: 0, reverted: 0 });
    expect(await readPending()).toEqual([]);
  });

  it('leaves the article archived — the local mark was the point', async () => {
    await seed(1);
    await markLocally(1, 'archived', NOW);
    await queueAction(1, 'archive', NOW);

    await flushPending({ send: recording().send });
    expect((await readBookmark(1))?.state).toBe('archived');
  });
});

describe('a transient failure', () => {
  it('keeps the intent and leaves the article marked', async () => {
    // Offline is the whole reason this exists: `fetch` throws a TypeError, which is
    // not an ApiError at all and must land on the retry side.
    await seed(1);
    await markLocally(1, 'archived', NOW);
    await queueAction(1, 'archive', NOW);

    const result = await flushPending({
      send: () => Promise.reject(new TypeError('Failed to fetch')),
    });

    expect(result).toMatchObject({ sent: 0, deferred: 1, reverted: 0 });
    expect(await readPending()).toHaveLength(1);
    expect((await readBookmark(1))?.state).toBe('archived');
  });

  it('records why, for the reader to see', async () => {
    await seed(1);
    await queueAction(1, 'archive', NOW);
    await flushPending({ send: () => Promise.reject(new ApiError(502, 'Instapaper unreachable')) });

    expect(await readPendingFor(1)).toMatchObject({
      attempts: 1,
      last_error: 'Instapaper unreachable',
    });
  });

  it('treats a 5xx as worth retrying', () => {
    // 502 and 504 are what `api/archive` answers when Instapaper is unreachable or
    // slow — the deployment is fine and the next attempt may well work.
    for (const status of [500, 502, 503, 504, 429]) {
      expect(classify(new ApiError(status)), String(status)).toBe('retry');
    }
  });

  it('gives up after MAX_ATTEMPTS of *answered* failures', async () => {
    /*
     * A stop for an action that fails consistently for a reason this code cannot
     * classify, so it does not ask Instapaper the same unanswerable question on every
     * app start forever. `ApiError` and not a network error: only an answer counts.
     */
    await seed(1);
    await markLocally(1, 'archived', NOW);
    await queueAction(1, 'archive', NOW);

    let result;
    for (let i = 0; i < MAX_ATTEMPTS; i += 1) {
      resetFlushLock();
      result = await flushPending({ send: () => Promise.reject(new ApiError(500, 'boom')) });
    }

    expect(result).toMatchObject({ reverted: 1 });
    expect(await readPending()).toEqual([]);
    // Back in the queue, where the reader can see it and decide again.
    expect((await readBookmark(1))?.state).toBe('unread');
    expect((await readBookmark(1))?.purge_after).toBeNull();
  });
});

describe('being offline', () => {
  it('never spends the retry budget, however many times the queue is flushed', async () => {
    /*
     * The bug the browser run found, pinned.
     *
     * A flush fires on app start, on `online`, and on every queued action, so an
     * offline session racks them up fast — five attempts inside one, in the run that
     * caught this. Counting them meant a reader archiving a handful of articles on a
     * train would watch them reappear, reverted for exceeding a budget while the
     * network was never there to answer. Silence is not evidence about an action.
     */
    await seed(1);
    await markLocally(1, 'archived', NOW);
    await queueAction(1, 'archive', NOW);

    for (let i = 0; i < MAX_ATTEMPTS * 4; i += 1) {
      resetFlushLock();
      await flushPending({ send: () => Promise.reject(new TypeError('Failed to fetch')) });
    }

    expect(await readPending()).toHaveLength(1);
    expect((await readPendingFor(1))?.attempts).toBe(0);
    // Still archived locally — the reader's decision has not been undone.
    expect((await readBookmark(1))?.state).toBe('archived');
  });

  it('still records the reason, so it is not invisible', async () => {
    await seed(1);
    await queueAction(1, 'archive', NOW);
    await flushPending({ send: () => Promise.reject(new TypeError('Failed to fetch')) });

    expect(await readPendingFor(1)).toMatchObject({
      attempts: 0,
      last_error: 'Failed to fetch',
    });
  });

  it('sends the moment there is a network again', async () => {
    await seed(1);
    await queueAction(1, 'archive', NOW);
    for (let i = 0; i < 3; i += 1) {
      resetFlushLock();
      await flushPending({ send: () => Promise.reject(new TypeError('offline')) });
    }

    resetFlushLock();
    const { asked, send } = recording();
    expect(await flushPending({ send })).toMatchObject({ sent: 1 });
    expect(asked).toEqual(['archive:1']);
  });
});

describe('a permanent failure', () => {
  it('is only the statuses that cannot ever succeed', () => {
    expect(classify(new ApiError(400))).toBe('permanent');
    expect(classify(new ApiError(404))).toBe('permanent');
    expect(classify(new ApiError(410))).toBe('permanent');
    // The conservative direction between retrying and giving up is "retry": keeping a
    // doomed intent costs a handful of requests, dropping a good one loses the
    // reader's decision silently.
    expect(classify(new ApiError(429))).toBe('retry');
    // And anything with no status at all never reached a server.
    expect(classify(new TypeError('Failed to fetch'))).toBe('unreachable');
    expect(classify(new Error('anything else'))).toBe('unreachable');
  });

  it('puts the article back rather than leaving it in limbo', async () => {
    // Neither in Instapaper's archive nor in the reader's queue is the one state
    // nobody can act on.
    await seed(1);
    await markLocally(1, 'archived', NOW);
    await queueAction(1, 'archive', NOW);

    const result = await flushPending({ send: () => Promise.reject(new ApiError(400, 'bad id')) });

    expect(result).toMatchObject({ sent: 0, deferred: 0, reverted: 1 });
    expect(await readPending()).toEqual([]);
    expect((await readBookmark(1))?.state).toBe('unread');
  });

  it('restores the cached text and image rather than letting them be purged', async () => {
    await seed(1);
    const db = await getDb();
    await db.put('article_text', {
      key: '1:instapaper',
      bookmark_id: 1,
      source: 'instapaper',
      html: '<p>Text.</p>',
      fetched_at: NOW,
      purge_after: null,
    });
    await markLocally(1, 'archived', NOW);
    expect((await db.get('article_text', '1:instapaper'))?.purge_after).not.toBeNull();

    await queueAction(1, 'archive', NOW);
    await flushPending({ send: () => Promise.reject(new ApiError(400)) });

    expect(await (await getDb()).get('article_text', '1:instapaper')).toMatchObject({
      purge_after: null,
      html: '<p>Text.</p>',
    });
  });
});

describe('an expired session', () => {
  it('stops the pass without spending an attempt on anything', async () => {
    /*
     * The gate lapsing is a fact about the session, not about any one article.
     * Counting it would burn the whole queue's retry budget on one expired cookie.
     */
    await seed(1, 2, 3);
    await queueAction(1, 'archive', NOW);
    await queueAction(2, 'archive', NOW + 1);
    await queueAction(3, 'archive', NOW + 2);

    const { asked, send } = recording(() => Promise.reject(new ApiError(401, 'unauthorized')));
    const result = await flushPending({ send });

    expect(result.unauthorized).toBe(true);
    // Stopped at the first, rather than failing all three the same way.
    expect(asked).toEqual(['archive:1']);
    expect(await readPending()).toHaveLength(3);
    expect((await readPendingFor(1))?.attempts).toBe(0);
  });
});

describe('a mixed queue', () => {
  it('carries on past one article to reach the next', async () => {
    await seed(1, 2, 3);
    await queueAction(1, 'archive', NOW);
    await queueAction(2, 'archive', NOW + 1);
    await queueAction(3, 'archive', NOW + 2);

    const { asked, send } = recording((id) => {
      if (id === 1) return Promise.reject(new TypeError('offline'));
      if (id === 2) return Promise.reject(new ApiError(400));
      return Promise.resolve();
    });

    const result = await flushPending({ send });

    expect(asked).toEqual(['archive:1', 'archive:2', 'archive:3']);
    expect(result).toMatchObject({ sent: 1, deferred: 1, reverted: 1 });
    // Only the transient one is still waiting.
    expect((await readPending()).map((row) => row.bookmark_id)).toEqual([1]);
  });
});

describe('the flush lock', () => {
  it('collapses overlapping passes into one', async () => {
    /*
     * Three things drain this queue — app start, coming back online, and queueing an
     * action — and on a phone rejoining a network they fire milliseconds apart.
     * Overlapping passes would read the same rows and send the same archive twice.
     */
    await seed(1);
    await queueAction(1, 'archive', NOW);

    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const asked: number[] = [];
    const send = async (_action: 'archive' | 'delete', id: number) => {
      asked.push(id);
      await gate;
    };

    const first = flushOnce({ send });
    const second = flushOnce({ send });
    expect(second).toBe(first);

    release?.();
    await Promise.all([first, second]);
    expect(asked).toEqual([1]);
  });

  it('releases the lock so a later pass runs', async () => {
    await seed(1, 2);
    await queueAction(1, 'archive', NOW);
    await flushOnce({ send: recording().send });

    await queueAction(2, 'archive', NOW + 1);
    const { asked, send } = recording();
    await flushOnce({ send });
    expect(asked).toEqual(['archive:2']);
  });

  it('releases the lock even when the pass throws', async () => {
    await seed(1);
    await queueAction(1, 'archive', NOW);

    await expect(
      flushOnce({
        send: () => {
          throw new RangeError('something unexpected');
        },
      }),
    ).resolves.toMatchObject({ deferred: 1 });

    await clearPending(1);
    const { send } = recording();
    await expect(flushOnce({ send })).resolves.toMatchObject({ sent: 0 });
  });
});
