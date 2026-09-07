// @vitest-environment jsdom
//
// Furniture removal runs in the browser, on the platform's own `DOMParser`, so it
// is tested against a real DOM rather than against linkedom. That is the whole
// point of the split from `cleaners.ts`: these rules must hold on the parser that
// will actually run them.
import { describe, expect, it } from 'vitest';

import { FURNITURE_MARKERS, MAX_FURNITURE_CHARS, removeFurniture } from '../src/lib/furniture';
import { plainText } from '../src/lib/truncation';

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
