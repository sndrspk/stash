import { describe, expect, it } from 'vitest';

import {
  FURNITURE_MARKERS,
  MAX_FURNITURE_CHARS,
  MIN_HERO_WIDTH,
  cleanExtracted,
  findHeroImage,
  normalizeTitle,
  removeDuplicateTitle,
  removeFurniture,
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

describe('removeFurniture', () => {
  it('removes a newsletter block', () => {
    const out = removeFurniture(
      '<p>Real prose.</p><div>Sign up for our newsletter to get this in your inbox.</div>',
    );
    expect(out).toContain('Real prose.');
    expect(out).not.toContain('newsletter');
  });

  it('removes a "read more" block and a related-articles list', () => {
    const out = removeFurniture(
      '<p>Real prose.</p><p>Read more: something else</p><aside>Related stories</aside>',
    );
    expect(plainText(out)).toBe('Real prose.');
  });

  it('never takes a real paragraph with it', () => {
    // The length bound is what stops a marker appearing mid-sentence removing the
    // sentence. A block has to be short enough to *be* furniture.
    const long = `<p>${'The word advertisement appears in this genuine paragraph. '.repeat(20)}</p>`;
    expect(plainText(removeFurniture(long)).length).toBeGreaterThan(MAX_FURNITURE_CHARS);
  });

  it('removes a block that is only a subscription link', () => {
    const out = removeFurniture('<p>Real prose.</p><p><a href="/subscribe">Subscribe</a></p>');
    expect(plainText(out)).toBe('Real prose.');
  });

  it('keeps a paragraph that merely contains a link', () => {
    const out = removeFurniture(
      '<p>A long paragraph of genuine article prose which happens to link to ' +
        '<a href="/subscribe">the subscription page</a> in passing, as articles do.</p>',
    );
    expect(out).toContain('genuine article prose');
  });

  it('keys on signals, never on a publisher', () => {
    // The rule that keeps the list from rotting: a hostname list is wrong for every
    // site not on it, and silently wrong for every site that changes.
    for (const marker of FURNITURE_MARKERS) {
      expect(marker).not.toMatch(/\.(com|nl|co\.uk|org)\b/);
    }
  });

  it('takes an extra marker without touching the defaults', () => {
    const fragment = '<p>Real prose.</p><p>Steun onze journalistiek</p>';
    expect(removeFurniture(fragment)).toContain('Steun onze');
    expect(plainText(removeFurniture(fragment, ['steun onze journalistiek']))).toBe('Real prose.');
  });

  it('is safe to run twice — it is a render-time pass', () => {
    // The whole reason it runs at render: a new rule must fix cached articles, so
    // the same fragment goes through it on every read.
    const fragment = '<p>Real prose.</p><div>Advertisement</div>';
    const once = removeFurniture(fragment);
    expect(removeFurniture(once)).toBe(once);
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
