import { describe, expect, it } from 'vitest';

import type { BookmarkRecord, ImageCacheRecord } from '../src/lib/db';
import {
  CARD_EXCERPT_CHARS,
  HERO_EXCERPT_CHARS,
  SECONDARY_SLOTS,
  SIDEBAR_LENGTH,
  chooseSlots,
  deriveExcerpt,
  excerptFor,
  hasImage,
  needsExcerptText,
} from '../src/lib/front-page';

const bookmark = (id: number, over: Partial<BookmarkRecord> = {}): BookmarkRecord => ({
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
  ...over,
});

const image = (url: string, over: Partial<ImageCacheRecord> = {}): ImageCacheRecord => ({
  url,
  image_url: `${url}#img`,
  status: 'ok',
  resolved_at: 0,
  purge_after: null,
  ...over,
});

/** A cache in which every listed bookmark has a picture and nothing else does. */
const withImages = (bookmarks: readonly BookmarkRecord[]) =>
  new Map(bookmarks.map((b) => [b.url, image(b.url)]));

const ids = (bookmarks: readonly BookmarkRecord[]) => bookmarks.map((b) => b.bookmark_id);

describe('hasImage', () => {
  it('is true only for a resolved picture', () => {
    expect(hasImage(image('https://a/1'))).toBe(true);
  });

  it('is false for a page that has none, an error, or no row at all', () => {
    expect(hasImage(image('https://a/1', { status: 'none', image_url: null }))).toBe(false);
    expect(hasImage(image('https://a/1', { status: 'error', image_url: null }))).toBe(false);
    expect(hasImage(undefined)).toBe(false);
  });

  it('is false for an ok row with an empty URL, which is not a picture', () => {
    expect(hasImage(image('https://a/1', { image_url: '' }))).toBe(false);
  });
});

describe('the image slots', () => {
  // The rule the whole phase turns on.
  it('never puts an article without a picture in an image slot', () => {
    const all = Array.from({ length: 20 }, (_, i) => bookmark(i + 1));
    const illustrated = all.slice(0, 6);
    const images = withImages(illustrated);
    const allowed = new Set(ids(illustrated));

    // Every seed, not one: a rule that holds for the seed you happened to try is
    // not a rule.
    for (let seed = 0; seed < 200; seed++) {
      const slots = chooseSlots(all, images, seed);
      expect(slots.hero).not.toBeNull();
      expect(allowed.has(slots.hero!.bookmark_id), `seed ${seed}`).toBe(true);
      for (const secondary of slots.secondaries) {
        expect(allowed.has(secondary.bookmark_id), `seed ${seed}`).toBe(true);
      }
    }
  });

  it('fills a hero and three secondaries when there are enough', () => {
    const all = Array.from({ length: 10 }, (_, i) => bookmark(i + 1));
    const slots = chooseSlots(all, withImages(all), 7);

    expect(slots.hero).not.toBeNull();
    expect(slots.secondaries).toHaveLength(SECONDARY_SLOTS);
  });

  it('never repeats an article across the four slots', () => {
    const all = Array.from({ length: 8 }, (_, i) => bookmark(i + 1));
    for (let seed = 0; seed < 100; seed++) {
      const slots = chooseSlots(all, withImages(all), seed);
      const chosen = ids([slots.hero!, ...slots.secondaries]);
      expect(new Set(chosen).size, `seed ${seed}`).toBe(chosen.length);
    }
  });

  it('leaves slots empty rather than filling them badly', () => {
    const all = [bookmark(1), bookmark(2), bookmark(3)];
    const slots = chooseSlots(all, withImages([all[0]!, all[1]!]), 1);

    expect(slots.hero).not.toBeNull();
    expect(slots.secondaries).toHaveLength(1);
    expect(slots.illustrated).toBe(2);
  });

  it('has no hero at all when nothing has a picture', () => {
    const all = [bookmark(1), bookmark(2)];
    const slots = chooseSlots(all, new Map(), 1);

    expect(slots.hero).toBeNull();
    expect(slots.secondaries).toEqual([]);
    expect(slots.illustrated).toBe(0);
    // The articles are still on the page, in the lists.
    expect(ids(slots.newest)).toEqual([2, 1]);
  });

  it('reshuffles for a different seed and is stable for the same one', () => {
    const all = Array.from({ length: 12 }, (_, i) => bookmark(i + 1));
    const images = withImages(all);

    const a = chooseSlots(all, images, 1);
    const again = chooseSlots(all, images, 1);
    expect(ids([a.hero!, ...a.secondaries])).toEqual(ids([again.hero!, ...again.secondaries]));

    // Not every seed differs from every other, but across a range they must.
    const heroes = new Set(
      Array.from({ length: 40 }, (_, seed) => chooseSlots(all, images, seed).hero?.bookmark_id),
    );
    expect(heroes.size).toBeGreaterThan(1);
  });
});

describe('the sidebar lists', () => {
  const all = Array.from({ length: 20 }, (_, i) => bookmark(i + 1));

  it('is newest-first and oldest-first respectively', () => {
    const slots = chooseSlots(all, new Map(), 3);

    expect(ids(slots.newest)).toEqual([20, 19, 18, 17, 16]);
    expect(ids(slots.oldest)).toEqual([1, 2, 3, 4, 5]);
    expect(slots.newest).toHaveLength(SIDEBAR_LENGTH);
  });

  it('excludes the four articles already on show', () => {
    // A front page that runs its lead story again halfway down the sidebar has
    // spent a row saying nothing.
    const images = withImages(all);
    for (let seed = 0; seed < 50; seed++) {
      const slots = chooseSlots(all, images, seed);
      const onShow = new Set(ids([slots.hero!, ...slots.secondaries]));
      for (const listed of [...slots.newest, ...slots.oldest]) {
        expect(onShow.has(listed.bookmark_id), `seed ${seed}`).toBe(false);
      }
    }
  });

  it('never prints the same article in both lists', () => {
    // Seven unread cannot fill two lists of five without overlapping.
    const few = Array.from({ length: 7 }, (_, i) => bookmark(i + 1));
    const slots = chooseSlots(few, new Map(), 2);

    const overlap = ids(slots.newest).filter((id) => ids(slots.oldest).includes(id));
    expect(overlap).toEqual([]);
    expect([...ids(slots.newest), ...ids(slots.oldest)]).toHaveLength(7);
  });

  it('holds every unread article exactly once between the slots and the lists', () => {
    const few = Array.from({ length: 9 }, (_, i) => bookmark(i + 1));
    const slots = chooseSlots(few, withImages(few), 5);

    const shown = ids([slots.hero!, ...slots.secondaries, ...slots.newest, ...slots.oldest]);
    expect(new Set(shown).size).toBe(shown.length);
    expect(new Set(shown)).toEqual(new Set(ids(few)));
  });

  it('is empty when everything unread is already in a slot', () => {
    const four = Array.from({ length: 4 }, (_, i) => bookmark(i + 1));
    const slots = chooseSlots(four, withImages(four), 1);

    expect(slots.newest).toEqual([]);
    expect(slots.oldest).toEqual([]);
  });
});

describe('an empty queue', () => {
  it('yields nothing at all rather than throwing', () => {
    expect(chooseSlots([], new Map(), 1)).toEqual({
      hero: null,
      secondaries: [],
      newest: [],
      oldest: [],
      illustrated: 0,
    });
  });
});

describe('deriveExcerpt', () => {
  it('strips tags and collapses whitespace', () => {
    expect(deriveExcerpt('<p>One   <em>two</em>\n<b>three</b></p>', 100)).toBe('One two three');
  });

  it('decodes the entities that actually appear in prose', () => {
    expect(deriveExcerpt('<p>Fish&nbsp;&amp;&nbsp;chips &quot;here&quot;</p>', 100)).toBe(
      'Fish & chips "here"',
    );
  });

  it('never lets script or style contents become the excerpt', () => {
    const html = '<style>.a{color:red}</style><script>var x=1</script><p>The article.</p>';
    expect(deriveExcerpt(html, 100)).toBe('The article.');
  });

  it('leaves a short text exactly as it is, with no ellipsis', () => {
    expect(deriveExcerpt('<p>Short enough.</p>', 100)).toBe('Short enough.');
  });

  it('prefers a sentence end to a word cut', () => {
    const text = 'The first sentence ends here. The second one runs on and on and on and on.';
    expect(deriveExcerpt(text, 45)).toBe('The first sentence ends here.');
  });

  it('cuts on a word boundary when there is no sentence to end on', () => {
    const text = 'alpha bravo charlie delta echo foxtrot golf hotel india juliet kilo';
    const excerpt = deriveExcerpt(text, 30);

    expect(excerpt.endsWith('…')).toBe(true);
    expect(excerpt.length).toBeLessThanOrEqual(31);
    // No half-words: every word in the excerpt is one from the source.
    const words = excerpt.replace('…', '').trim().split(' ');
    for (const word of words) expect(text.split(' ')).toContain(word);
  });

  it('does not leave a dangling comma or dash before the ellipsis', () => {
    expect(deriveExcerpt('alpha bravo, charlie delta', 13)).toBe('alpha bravo…');
  });

  it('handles an empty document', () => {
    expect(deriveExcerpt('', 100)).toBe('');
    expect(deriveExcerpt('<p></p>', 100)).toBe('');
  });
});

describe('excerptFor', () => {
  it('uses the description when there is one, and does not fetch text to do it', () => {
    const withDescription = bookmark(1, { description: 'What Instapaper already knows.' });
    expect(excerptFor(withDescription, '<p>The whole article.</p>', HERO_EXCERPT_CHARS)).toBe(
      'What Instapaper already knows.',
    );
  });

  it('falls back to the article text when the description is blank', () => {
    expect(excerptFor(bookmark(1, { description: '   ' }), '<p>The article.</p>', 100)).toBe(
      'The article.',
    );
  });

  it('is empty when there is neither, rather than showing a placeholder', () => {
    expect(excerptFor(bookmark(1), undefined, CARD_EXCERPT_CHARS)).toBe('');
    expect(excerptFor(bookmark(1), '   ', CARD_EXCERPT_CHARS)).toBe('');
  });
});

describe('needsExcerptText', () => {
  it('names only the slot articles with no description', () => {
    const all = [
      bookmark(1),
      bookmark(2, { description: 'Has one.' }),
      bookmark(3),
      bookmark(4, { description: 'Has one too.' }),
      bookmark(5),
    ];
    const slots = chooseSlots(all, withImages(all), 11);

    const wanted = needsExcerptText(slots);
    const inSlots = new Set(ids([slots.hero!, ...slots.secondaries]));

    for (const bookmarkWanted of wanted) {
      expect(inSlots.has(bookmarkWanted.bookmark_id)).toBe(true);
      expect(bookmarkWanted.description.trim()).toBe('');
    }
    // Never more than the four slots, whatever the queue looks like.
    expect(wanted.length).toBeLessThanOrEqual(1 + SECONDARY_SLOTS);
  });

  it('asks for nothing when every slot article has a description', () => {
    const all = Array.from({ length: 6 }, (_, i) => bookmark(i + 1, { description: 'Given.' }));
    expect(needsExcerptText(chooseSlots(all, withImages(all), 4))).toEqual([]);
  });

  it('asks for nothing when there are no slots to fill', () => {
    expect(needsExcerptText(chooseSlots([], new Map(), 1))).toEqual([]);
  });
});
