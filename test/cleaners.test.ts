import { parseHTML } from 'linkedom';
import { describe, expect, it } from 'vitest';

import {
  MIN_HERO_WIDTH,
  cleanExtracted,
  findHeroImage,
  findLede,
  normalizeTitle,
  removeDuplicateTitle,
  restoreLede,
  restoreMissingIntro,
} from '../src/lib/cleaners';
import { plainText } from '../src/lib/truncation';

describe('normalizeTitle', () => {
  it('ignores case, punctuation and spacing', () => {
    expect(normalizeTitle('The Tunnel — Under the Mountain!')).toBe(
      'the tunnel under the mountain',
    );
    expect(normalizeTitle('  A   B  ')).toBe('a b');
  });

  it('strips markup, so a heading with a <span> in it still compares', () => {
    expect(normalizeTitle('<h1>The <span>tunnel</span></h1>')).toBe('the tunnel');
  });
});

describe('removeDuplicateTitle', () => {
  const title = 'The tunnel under the mountain';

  it('removes an exact repeat of the headline', () => {
    const out = removeDuplicateTitle(`<h1>${title}</h1><p>The article.</p>`, title);
    expect(out).not.toContain('<h1>');
    expect(out).toContain('The article.');
  });

  it('removes it despite different punctuation and case', () => {
    const out = removeDuplicateTitle('<h1>THE TUNNEL, UNDER THE MOUNTAIN</h1><p>Body.</p>', title);
    expect(out).not.toContain('<h1>');
  });

  it('removes the "Title | Site Name" shape', () => {
    // The common one, and the reason the comparison is a ratio rather than equality.
    const out = removeDuplicateTitle(`<h1>${title} | The Daily Example</h1><p>Body.</p>`, title);
    expect(out).not.toContain('<h1>');
  });

  it('keeps a heading that merely shares a few words', () => {
    const out = removeDuplicateTitle('<h1>The mountain</h1><p>Body.</p>', title);
    expect(out).toContain('<h1>');
  });

  it('keeps a section heading further down the article', () => {
    // An <h2> halfway through that echoes the title is a section break, not a
    // duplicate — and removing it would silently restructure the piece.
    const fragment = `<p>An opening paragraph with real prose in it.</p><h2>${title}</h2><p>More.</p>`;
    expect(removeDuplicateTitle(fragment, title)).toContain('<h2>');
  });

  it('prunes a wrapper the heading leaves empty', () => {
    const out = removeDuplicateTitle(
      `<header><div><h1>${title}</h1></div></header><p>Body.</p>`,
      title,
    );
    expect(out).not.toContain('<header>');
    expect(out).not.toContain('<div>');
    expect(out).toContain('Body.');
  });

  it('keeps a wrapper that still holds something', () => {
    const out = removeDuplicateTitle(
      `<header><h1>${title}</h1><p>By a reporter</p></header><p>Body.</p>`,
      title,
    );
    expect(out).toContain('<header>');
    expect(out).toContain('By a reporter');
  });

  it('does nothing without a title, or without a heading', () => {
    expect(removeDuplicateTitle('<p>Body.</p>', title)).toBe('<p>Body.</p>');
    expect(removeDuplicateTitle('<h1>Anything</h1>', '')).toBe('<h1>Anything</h1>');
    expect(removeDuplicateTitle('<h1>Anything</h1>', '   ')).toBe('<h1>Anything</h1>');
  });
});

describe('restoreMissingIntro', () => {
  const excerpt =
    'Ministers agreed on Thursday to delay the scheme by a year, citing costs that had tripled.';

  it('prepends an intro the extractor dropped', () => {
    const fragment = '<p>The decision follows months of argument between the two departments.</p>';
    const out = restoreMissingIntro(fragment, excerpt);

    expect(out.startsWith('<p>')).toBe(true);
    expect(plainText(out)).toContain('Ministers agreed on Thursday');
    expect(out).toContain('The decision follows');
  });

  it('leaves the article alone when the excerpt is already its opening', () => {
    const fragment = `<p>${excerpt}</p><p>The decision follows months of argument.</p>`;
    expect(restoreMissingIntro(fragment, excerpt)).toBe(fragment);
  });

  it('tolerates a small rewording rather than duplicating the paragraph', () => {
    // Under the threshold: an excerpt is often trimmed or lightly edited, and
    // prepending a near-copy of the first paragraph is worse than doing nothing.
    const fragment =
      '<p>Ministers agreed on Thursday to delay the scheme by a year, citing costs.</p>';
    expect(restoreMissingIntro(fragment, excerpt)).toBe(fragment);
  });

  it('only looks at the start of the article', () => {
    // Finding the excerpt's words in the final paragraph proves nothing: an excerpt
    // is drawn from the opening.
    const filler = '<p>Unrelated prose about something else entirely.</p>'.repeat(20);
    const out = restoreMissingIntro(`${filler}<p>${excerpt}</p>`, excerpt);
    expect(plainText(out).startsWith('Ministers agreed')).toBe(true);
  });

  it('restores prose, not markup', () => {
    const rich = `<figure><img src="https://a/x.jpg"></figure><h2>A heading</h2><p>${excerpt}</p>`;
    const out = restoreMissingIntro('<p>Something else entirely, quite different.</p>', rich);

    expect(out).not.toContain('<img');
    expect(out).not.toContain('<h2');
    expect(plainText(out)).toContain('Ministers agreed');
  });

  it('escapes what it prepends', () => {
    const out = restoreMissingIntro('<p>Body.</p>', 'A <script>alert(1)</script> excerpt');
    expect(out).not.toContain('<script');
  });

  it('does nothing without an excerpt', () => {
    expect(restoreMissingIntro('<p>Body.</p>', '')).toBe('<p>Body.</p>');
    expect(restoreMissingIntro('<p>Body.</p>', '   ')).toBe('<p>Body.</p>');
  });
});

describe('findHeroImage', () => {
  it('prefers the first image inside a figure', () => {
    const out = findHeroImage(
      '<img src="https://a/small.jpg"><figure><img src="https://a/hero.jpg" alt="A photo"></figure>',
    );
    expect(out).toEqual({ src: 'https://a/hero.jpg', alt: 'A photo' });
  });

  it('falls back to an image that declares itself wide enough', () => {
    const out = findHeroImage(
      `<img src="https://a/thumb.jpg" width="120"><img src="https://a/big.jpg" width="${MIN_HERO_WIDTH}">`,
    );
    expect(out?.src).toBe('https://a/big.jpg');
  });

  it('returns nothing rather than guessing', () => {
    // A wrong hero is worse than none, and the front page has its own resolver for
    // the case where an article has no usable image.
    expect(findHeroImage('<p>No pictures here.</p>')).toBeNull();
    expect(findHeroImage('<img src="https://a/x.jpg" width="200">')).toBeNull();
    expect(findHeroImage('<img src="https://a/x.jpg">')).toBeNull();
  });
});

describe('cleanExtracted', () => {
  it('applies title and intro, and leaves furniture for render time', () => {
    const fragment =
      '<h1>A headline</h1><p>Different opening prose entirely.</p><p>Advertisement</p>';
    const out = cleanExtracted(fragment, {
      title: 'A headline',
      excerpt: 'Ministers agreed on Thursday to delay the scheme by a year, citing tripled costs.',
    });

    expect(out).not.toContain('<h1>');
    expect(plainText(out)).toContain('Ministers agreed on Thursday');
    // Still there: furniture is removed on the way to the screen, not into storage,
    // so a rule added later can still reach it.
    expect(out).toContain('Advertisement');
  });

  it('does nothing without metadata', () => {
    const fragment = '<h1>A headline</h1><p>Body.</p>';
    expect(cleanExtracted(fragment)).toBe(fragment);
  });
});

/*
 * The standfirst recovery.
 *
 * Readability returns the container with the highest density of paragraphs. A
 * standfirst is routinely one `<h2>` in an `<hgroup>` beside the body — headline,
 * standfirst, byline, date — and that group scores nothing, so the article's opening
 * paragraph is dropped on every article that publisher runs while the extraction
 * otherwise looks perfect. Shape taken from a real page.
 */
function pageWith(intro: string, attrs = 'data-testid="article-intro"'): Document {
  const { document } = parseHTML(`<!doctype html><html><body>
    <article>
      <hgroup>
        <h1 data-testid="article-headline">The headline</h1>
        <h2 ${attrs}>${intro}</h2>
      </hgroup>
      <div class="article-body_articleBody__uvPY2">
        <p>The body starts here and carries on for a while.</p>
      </div>
    </article>
  </body></html>`) as unknown as { document: Document };
  return document;
}

const LEDE = 'Anderlecht moet zeer dringend matchen over de streep leren trekken, en wel nu.';

describe('findLede', () => {
  it('finds a standfirst beside the body, not inside it', () => {
    expect(findLede(pageWith(LEDE))).toBe(LEDE);
  });

  it('reads the marker out of a hashed CSS-module class', () => {
    // `story-intro_storyIntro__7SJ5Q` is what a bundler emits, and the readable half is
    // the only part that carries meaning. camelCase has to split too, or the hashed
    // class of every modern site is invisible here.
    expect(
      findLede(pageWith(LEDE, 'class="Paragraph_paragraph__x story-intro_storyIntro__7SJ5Q"')),
    ).toBe(LEDE);
  });

  it('does not match a word that merely contains a marker', () => {
    // Dutch `ontdek-meer` contains `dek`; `leaderboard` contains `lead`. Substring
    // matching here would key on an accident of spelling.
    expect(findLede(pageWith(LEDE, 'class="ontdek-meer"'))).toBeNull();
    expect(findLede(pageWith(LEDE, 'class="leaderboard-slot"'))).toBeNull();
  });

  it('ignores a label rather than prose', () => {
    expect(findLede(pageWith('Analyse'))).toBeNull();
  });

  it('ignores a block that is mostly links', () => {
    const links = Array.from(
      { length: 6 },
      (_, i) => `<a href="/x${String(i)}">Another article to read next about football</a>`,
    ).join(' ');
    expect(findLede(pageWith(links))).toBeNull();
  });

  it('ignores something too long to be a summary', () => {
    expect(findLede(pageWith('word '.repeat(400)))).toBeNull();
  });

  it('separates a dateline from the first word', () => {
    // `textContent` would give `BRUSSELAnderlecht`, which is what the reader would see.
    expect(findLede(pageWith(`<span>BRUSSEL</span>${LEDE}`))).toBe(`BRUSSEL ${LEDE}`);
  });
});

describe('restoreLede', () => {
  it('puts the standfirst in front of the article', () => {
    expect(restoreLede('<p>Body.</p>', LEDE)).toBe(`<p>${LEDE}</p><p>Body.</p>`);
  });

  it('does nothing when there is no standfirst', () => {
    expect(restoreLede('<p>Body.</p>', null)).toBe('<p>Body.</p>');
    expect(restoreLede('<p>Body.</p>', '   ')).toBe('<p>Body.</p>');
  });

  it('does not print it twice when Readability already kept it', () => {
    // The failure this guard exists for is worse than the bug it accompanies, and
    // harder to spot: a duplicated opening paragraph reads like the publisher's own
    // repetition rather than like something we did.
    const already = `<p>${LEDE}</p><p>Body.</p>`;
    expect(restoreLede(already, LEDE)).toBe(already);
  });

  it('sees through the whitespace and entities Readability rewrites', () => {
    const already = `<p>Anderlecht   moet zeer dringend matchen over de streep leren trekken,\nen wel nu.</p>`;
    expect(restoreLede(already, LEDE)).toBe(already);
  });

  it('escapes what it inserts, since this is publisher text', () => {
    const out = restoreLede('<p>Body.</p>', 'Tom & Jerry <script>alert(1)</script> went to town');
    expect(out).toContain('&amp;');
    expect(out).not.toContain('<script>');
  });
});
