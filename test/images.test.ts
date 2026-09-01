// A real IndexedDB, so the skip rule is asserted against the store it actually reads.
import 'fake-indexeddb/auto';

import { beforeEach, describe, expect, it } from 'vitest';

import { ApiError } from '../src/lib/api-error';
import { IMAGE_RETRY_MS, closeDb } from '../src/lib/db';
import { resetImagePass, resolveImages, type ImageResolution } from '../src/lib/images';
import { needsImageLookup, readImage, writeImage } from '../src/lib/store';

const NOW = 1_700_000_000_000;

/** No throttling and no clock in these: the queue's own tests cover both. */
const immediate = { concurrency: 4, perHostDelayMs: 0, now: () => NOW };

beforeEach(async () => {
  resetImagePass();
  await closeDb();
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase('stash');
    request.onsuccess = request.onerror = request.onblocked = () => resolve();
  });
});

/** A lookup that answers from a table and counts what it was asked. */
function recording(answers: Record<string, ImageResolution> = {}) {
  const asked: string[] = [];
  const lookup = (url: string): Promise<ImageResolution> => {
    asked.push(url);
    return Promise.resolve(answers[url] ?? { status: 'ok', image_url: `${url}#img` });
  };
  return { asked, lookup };
}

describe('a first pass', () => {
  it('resolves every URL and caches each answer', async () => {
    const { asked, lookup } = recording();
    const urls = ['https://a.example/1', 'https://b.example/2', 'https://c.example/3'];

    const result = await resolveImages(urls, { ...immediate, lookup });

    expect(asked).toHaveLength(3);
    expect(result).toMatchObject({ requested: 3, skipped: 0, resolved: 3, none: 0, failed: 0 });
    expect((await readImage(urls[0]!))?.image_url).toBe('https://a.example/1#img');
  });

  it('asks once for a URL that appears twice in the queue', async () => {
    const { asked, lookup } = recording();
    const result = await resolveImages(
      ['https://a.example/1', 'https://a.example/1', 'https://a.example/1'],
      { ...immediate, lookup },
    );

    expect(asked).toEqual(['https://a.example/1']);
    expect(result.requested).toBe(1);
  });

  it('records "no image" as a real answer, not as a failure', async () => {
    const { lookup } = recording({
      'https://a.example/1': { status: 'none', image_url: null },
    });

    const result = await resolveImages(['https://a.example/1'], { ...immediate, lookup });

    expect(result).toMatchObject({ resolved: 0, none: 1, failed: 0 });
    expect(await readImage('https://a.example/1')).toMatchObject({
      status: 'none',
      image_url: null,
    });
  });

  it('records a failure rather than dropping it', async () => {
    // An unrecorded failure is retried on every sync forever, which is the exact
    // recurring cost this phase exists to avoid.
    const { lookup } = recording({
      'https://a.example/1': { status: 'error', image_url: null },
    });

    const result = await resolveImages(['https://a.example/1'], { ...immediate, lookup });

    expect(result.failed).toBe(1);
    expect((await readImage('https://a.example/1'))?.status).toBe('error');
  });

  it('treats a lookup that throws as a retryable failure', async () => {
    const result = await resolveImages(['https://a.example/1'], {
      ...immediate,
      lookup: () => Promise.reject(new TypeError('offline')),
    });

    expect(result.failed).toBe(1);
    expect((await readImage('https://a.example/1'))?.status).toBe('error');
  });
});

describe('the second pass', () => {
  // The phase's "done when", stated as one test: a full sync resolves images once,
  // and the next sync over the same queue makes no requests at all.
  it('makes no requests when every URL already has an answer', async () => {
    const urls = ['https://a.example/1', 'https://b.example/2', 'https://c.example/3'];
    const first = recording({ 'https://b.example/2': { status: 'none', image_url: null } });
    await resolveImages(urls, { ...immediate, lookup: first.lookup });
    expect(first.asked).toHaveLength(3);

    resetImagePass();
    const second = recording();
    const result = await resolveImages(urls, { ...immediate, lookup: second.lookup });

    expect(second.asked).toEqual([]);
    expect(result).toMatchObject({ requested: 3, skipped: 3, resolved: 0, none: 0, failed: 0 });
  });

  it('asks only about URLs that are new', async () => {
    await writeImage({
      url: 'https://a.example/1',
      image_url: 'https://cdn.example/a.jpg',
      status: 'ok',
      resolved_at: NOW,
      purge_after: null,
    });

    const probe = recording();
    const result = await resolveImages(['https://a.example/1', 'https://b.example/2'], {
      ...immediate,
      lookup: probe.lookup,
    });

    expect(probe.asked).toEqual(['https://b.example/2']);
    expect(result).toMatchObject({ requested: 2, skipped: 1, resolved: 1 });
  });

  it('leaves a failure alone until the retry interval has passed', async () => {
    await writeImage({
      url: 'https://a.example/1',
      image_url: null,
      status: 'error',
      resolved_at: NOW,
      purge_after: null,
    });

    const soon = recording();
    await resolveImages(['https://a.example/1'], {
      ...immediate,
      now: () => NOW + IMAGE_RETRY_MS - 1,
      lookup: soon.lookup,
    });
    expect(soon.asked).toEqual([]);

    resetImagePass();
    const later = recording();
    await resolveImages(['https://a.example/1'], {
      ...immediate,
      now: () => NOW + IMAGE_RETRY_MS,
      lookup: later.lookup,
    });
    expect(later.asked).toEqual(['https://a.example/1']);
  });

  it('never retries a negative result', async () => {
    await writeImage({
      url: 'https://a.example/1',
      image_url: null,
      status: 'none',
      resolved_at: NOW,
      purge_after: null,
    });

    // A page with no image will still have none in a year; asking again only ever
    // re-derives the same answer at the cost of a request.
    expect(await needsImageLookup('https://a.example/1', NOW + IMAGE_RETRY_MS * 52)).toBe(false);
  });
});

describe('an expired gate', () => {
  it('stops the pass and writes no rows, rather than poisoning the cache', async () => {
    const asked: string[] = [];
    const urls = Array.from({ length: 20 }, (_, i) => `https://host${i}.example/x`);

    await expect(
      resolveImages(urls, {
        ...immediate,
        concurrency: 1,
        lookup: (url) => {
          asked.push(url);
          return Promise.reject(new ApiError(401, 'unauthorized'));
        },
      }),
    ).rejects.toBeInstanceOf(ApiError);

    // The one request that discovered it is allowed; the other nineteen are not,
    // and none of them left an error row to be honoured for a week.
    expect(asked).toHaveLength(1);
    expect(await readImage(urls[0]!)).toBeUndefined();
  });
});

describe('overlapping passes', () => {
  it('sends nothing twice when two passes are started at once', async () => {
    // App start and an explicit refresh land within a second of each other
    // routinely. Run concurrently, neither pass would see the other's cache rows
    // and every URL they share would be fetched twice.
    const { asked, lookup } = recording();
    const urls = ['https://a.example/1', 'https://b.example/2'];

    const [first, second] = await Promise.all([
      resolveImages(urls, { ...immediate, lookup }),
      resolveImages(urls, { ...immediate, lookup }),
    ]);

    expect(asked).toEqual(urls);
    expect(first).toMatchObject({ resolved: 2, skipped: 0 });
    // The queued pass finds the rows the first one wrote, and asks nothing.
    expect(second).toMatchObject({ resolved: 0, skipped: 2 });
  });

  it('still resolves a list that arrives while a pass is running', async () => {
    // The reason this queues rather than skipping: a sync finishing mid-pass brings
    // new bookmarks, and dropping them would leave their pictures unresolved until
    // the app was next opened.
    const { asked, lookup } = recording();

    const first = resolveImages(['https://a.example/1'], { ...immediate, lookup });
    const second = resolveImages(['https://b.example/2'], { ...immediate, lookup });
    await Promise.all([first, second]);

    expect(asked).toEqual(['https://a.example/1', 'https://b.example/2']);
  });

  it('does not let a failed pass strand the ones behind it', async () => {
    const { asked, lookup } = recording();

    const failing = resolveImages(['https://a.example/1'], {
      ...immediate,
      lookup: () => Promise.reject(new ApiError(401, 'unauthorized')),
    });
    const following = resolveImages(['https://b.example/2'], { ...immediate, lookup });

    await expect(failing).rejects.toBeInstanceOf(ApiError);
    await expect(following).resolves.toMatchObject({ resolved: 1 });
    expect(asked).toEqual(['https://b.example/2']);
  });
});

describe('nothing to do', () => {
  it('returns an empty result for an empty list without touching the store', async () => {
    const { asked, lookup } = recording();
    expect(await resolveImages([], { ...immediate, lookup })).toMatchObject({ requested: 0 });
    expect(asked).toEqual([]);
  });

  it('ignores blank URLs', async () => {
    const { asked, lookup } = recording();
    expect(await resolveImages(['', '   '], { ...immediate, lookup })).toMatchObject({
      requested: 0,
    });
    expect(asked).toEqual([]);
  });
});
