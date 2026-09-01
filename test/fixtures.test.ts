import { describe, expect, it } from 'vitest';

import {
  anonymizeHtml,
  anonymizeText,
  anonymizeSrcset,
  anonymizeUrl,
  anonymizeUrlLike,
  assignShapes,
  measure,
  scrubUrl,
  toFixtureBookmark,
  type Candidate,
  type Measurements,
} from '../src/lib/fixtures';

describe('scrubUrl', () => {
  it('strips analytics parameters', () => {
    expect(scrubUrl('https://site.example/a?utm_source=news&utm_campaign=x&id=7')).toBe(
      'https://site.example/a?id=7',
    );
  });

  it('strips paywall bearer tokens', () => {
    // These grant article access tied to a subscription. Publishing one gives it
    // away, which is a different order of mistake from leaking an analytics tag.
    for (const param of ['giftLink', 'unlocked_article_code', 'share_id']) {
      expect(scrubUrl(`https://site.example/a?${param}=SECRET`)).not.toContain('SECRET');
    }
  });

  it('strips credentials and fragments', () => {
    expect(scrubUrl('https://user:pass@site.example/a#section')).toBe('https://site.example/a');
  });

  it('keeps parameters that identify the document', () => {
    // Dropping these would change which article the URL points at.
    expect(scrubUrl('https://site.example/view?articleId=99&page=2')).toBe(
      'https://site.example/view?articleId=99&page=2',
    );
  });

  it('returns unparseable input unchanged rather than throwing', () => {
    expect(scrubUrl('not a url')).toBe('not a url');
  });
});

describe('anonymizeText', () => {
  it('preserves length exactly', () => {
    // Phase 6 derives a column count from rendered height, so a shorter
    // anonymised article would silently test a different case.
    for (const input of ['Hello world', 'A', 'The quick brown fox jumps over the lazy dog']) {
      expect(anonymizeText(input)).toHaveLength(input.length);
    }
  });

  it('replaces the letters', () => {
    const input = 'Something confidential about a named person';
    const output = anonymizeText(input);
    expect(output).not.toBe(input);
    expect(output).not.toContain('confidential');
    expect(output).not.toContain('person');
  });

  it('preserves punctuation, digits and whitespace in place', () => {
    const output = anonymizeText('On 12 March, he said: "no."\n\nThen left.');
    expect(output).toContain('12');
    expect(output).toContain(',');
    expect(output).toContain(':');
    expect(output).toContain('"');
    expect(output).toContain('\n\n');
    expect(output.endsWith('.')).toBe(true);
  });

  it('preserves the case pattern', () => {
    const output = anonymizeText('McDonald ALLCAPS lower');
    expect(output[0]).toBe(output[0]?.toUpperCase());
    const [, second] = output.split(' ');
    expect(second).toBe(second?.toUpperCase());
  });

  it('is deterministic', () => {
    expect(anonymizeText('same input')).toBe(anonymizeText('same input'));
  });
});

describe('anonymizeUrl', () => {
  it('keeps path depth and file extension', () => {
    const output = anonymizeUrl('https://publisher.example/2024/03/investigation.html');
    expect(new URL(output).hostname).toBe('example.com');
    expect(output.endsWith('.html')).toBe(true);
    expect(new URL(output).pathname.split('/').filter(Boolean)).toHaveLength(3);
  });

  it('drops the publisher and the slug', () => {
    const output = anonymizeUrl('https://publisher.example/secret-investigation-into-someone');
    expect(output).not.toContain('publisher');
    expect(output).not.toContain('investigation');
  });

  it('falls back to a safe URL for junk', () => {
    expect(anonymizeUrl('nonsense')).toBe('https://example.com/');
  });
});

/*
 * The first fixtures written from a real account came out with srcsets like
 *
 *   srcset="https://example.com/sit/a.webp%20800w,%20https:/dolorelittempor.com/b.webp%201400w"
 *
 * which is not a srcset at all. The whole list had been handed to the single-URL
 * path, so `new URL()` took it as one pathname: commas and spaces percent-encoded
 * into one giant segment, descriptors swallowed inside it, and a segment ending in
 * `.com` re-emerging as a second hostname.
 *
 * These fixtures exist for Phase 4's image resolution and Phase 6's media clamping,
 * and those read the descriptors to choose a source and know how wide it is.
 */
describe('anonymizeSrcset', () => {
  it('keeps the list a list, with every descriptor intact', () => {
    const output = anonymizeSrcset(
      'https://media.publisher.example/hero-800.jpg 800w, https://media.publisher.example/hero-1400.jpg 1400w',
    );
    expect(output.split(', ')).toHaveLength(2);
    expect(output).toContain(' 800w');
    expect(output).toContain(' 1400w');
    expect(output).not.toContain('%20');
  });

  it('keeps pixel-density descriptors too', () => {
    expect(anonymizeSrcset('/a/hero.jpg 1x, /a/hero@2x.jpg 2x')).toMatch(/ 1x, .* 2x$/);
  });

  it('handles a bare url with no descriptor', () => {
    expect(anonymizeSrcset('https://media.publisher.example/hero.jpg').trim()).toBe(
      anonymizeSrcset('https://media.publisher.example/hero.jpg'),
    );
    expect(anonymizeSrcset('/a/hero.jpg')).not.toContain(' ');
  });

  it('invents no hostname other than example.com', () => {
    // The corrupted form produced `https:/dolorelittempor.com/...` out of a path
    // segment, which reads as a real third-party host in a committed fixture.
    const output = anonymizeSrcset(
      'https://a.publisher.example/x.jpg 1x, https://b.publisher.example/y.jpg 2x',
    );
    expect([...output.matchAll(/https?:\/\/([^/\s]+)/g)].map((m) => m[1])).toEqual([
      'example.com',
      'example.com',
    ]);
  });

  it('leaks no part of the publisher', () => {
    const output = anonymizeSrcset('https://media.publisher.example/news/hero-800.jpg 800w');
    expect(output).not.toContain('publisher');
    expect(output).not.toContain('news');
    expect(output).toContain('.jpg');
  });

  it('leaves a data: srcset alone rather than cutting it at a comma', () => {
    const data = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
    expect(anonymizeSrcset(data)).toBe(data);
  });

  it('survives empty and ragged input', () => {
    expect(anonymizeSrcset('')).toBe('');
    expect(() => anonymizeSrcset(',,  ,')).not.toThrow();
  });
});

describe('anonymizeHtml — responsive images', () => {
  it('rewrites srcset on source and img, keeping the markup valid', () => {
    const output = anonymizeHtml(
      '<picture>' +
        '<source media="(min-width: 768px)" type="image/webp" ' +
        'srcset="https://media.publisher.example/hero-800.webp 800w">' +
        '<img src="https://media.publisher.example/hero.jpg" width="1400" height="900">' +
        '</picture>',
    );
    expect(output).toContain('srcset="https://example.com/');
    expect(output).toContain('800w');
    expect(output).not.toContain('publisher.example');
    // Dimensions and art-direction metadata are structure, and must survive.
    expect(output).toContain('width="1400"');
    expect(output).toContain('media="(min-width: 768px)"');
    expect(output).toContain('type="image/webp"');
  });

  it('rewrites the lazy-loading attributes as well', () => {
    /*
     * data-srcset was in no list at all, so a lazyload image — extremely common —
     * carried the publisher's real URL straight into a committed fixture. data-src
     * was already handled; its sibling was not.
     */
    const output = anonymizeHtml(
      '<img class="lazyload" data-src="https://media.publisher.example/hero.jpg" ' +
        'data-srcset="https://media.publisher.example/hero-800.jpg 800w" ' +
        'src="data:image/gif;base64,R0lGOD">',
    );
    expect(output).not.toContain('publisher.example');
    expect(output).toContain('800w');
    // The class is a CSS hook Phase 7 selects on, and is deliberately kept.
    expect(output).toContain('class="lazyload"');
  });
});

describe('anonymizeUrlLike', () => {
  it('anonymises a relative page path', () => {
    // The leak an earlier version had: only absolute URLs were rewritten, so every
    // relative href kept the publisher's sections and headline slugs.
    const output = anonymizeUrlLike('/environment/the-real-headline-slug');
    expect(output.startsWith('/')).toBe(true);
    expect(output).not.toContain('environment');
    expect(output).not.toContain('headline');
    expect(output.split('/').filter(Boolean)).toHaveLength(2);
  });

  it('keeps the extension on a relative asset', () => {
    // Phase 4 branches on what an image URL looks like.
    expect(anonymizeUrlLike('/img/hero-1400.jpg').endsWith('.jpg')).toBe(true);
  });

  it('leaves the site root alone', () => {
    expect(anonymizeUrlLike('/')).toBe('/');
  });

  it('replaces a mailto address', () => {
    // A real address in a committed fixture is exactly what nobody meant to
    // publish.
    expect(anonymizeUrlLike('mailto:editor@publisher.example')).toBe('mailto:someone@example.com');
  });

  it('leaves schemes that substitution would corrupt', () => {
    for (const value of ['tel:+3112345678', 'data:image/png;base64,AAAA', 'javascript:void(0)']) {
      expect(anonymizeUrlLike(value), value).toBe(value);
    }
  });

  it('leaves a bare fragment alone', () => {
    expect(anonymizeUrlLike('#')).toBe('#');
  });

  it('handles protocol-relative URLs', () => {
    const output = anonymizeUrlLike('//cdn.publisher.example/a/b.png');
    expect(output.startsWith('//example.com/')).toBe(true);
    expect(output.endsWith('.png')).toBe(true);
  });
});

describe('anonymizeHtml', () => {
  const article = `
    <article>
      <h1>The real headline about a real event</h1>
      <p class="byline">By A Named Journalist</p>
      <figure>
        <img src="https://publisher.example/img/hero.jpg" width="1400" height="787" alt="A photograph of something">
        <figcaption>Caption text</figcaption>
      </figure>
      <p>First paragraph with <a href="https://publisher.example/related">a link</a> inside.</p>
      <table><tr><td>Data</td></tr></table>
      <pre><code>const secret = 1;</code></pre>
    </article>`;

  const output = anonymizeHtml(article);

  it('keeps every structural element', () => {
    for (const tag of [
      'article',
      'h1',
      'figure',
      'img',
      'figcaption',
      'a',
      'table',
      'pre',
      'code',
    ]) {
      expect(output, tag).toContain(`<${tag}`);
    }
  });

  it('keeps image dimensions verbatim', () => {
    // A declared width is exactly the sort of thing that breaks a column, so it
    // must survive anonymisation untouched.
    expect(output).toContain('width="1400"');
    expect(output).toContain('height="787"');
  });

  it('keeps class attributes', () => {
    expect(output).toContain('class="byline"');
  });

  it('removes the prose', () => {
    for (const word of ['headline', 'Journalist', 'Caption', 'paragraph', 'secret']) {
      expect(output, word).not.toContain(word);
    }
  });

  it('removes publisher URLs from href and src', () => {
    expect(output).not.toContain('publisher.example');
    expect(output).toContain('example.com');
  });

  it('anonymises alt text, which is prose too', () => {
    expect(output).not.toContain('photograph');
    expect(output).toContain('alt=');
  });

  it('leaves the paragraph count unchanged', () => {
    expect(measure(output).paragraphs).toBe(measure(article).paragraphs);
  });

  it('leaves the character count close to unchanged', () => {
    // Not exact: URLs are rewritten to a different length. Text is what matters.
    const before = measure(article).chars;
    const after = measure(output).chars;
    expect(Math.abs(after - before)).toBeLessThanOrEqual(2);
  });
});

describe('anonymizeHtml on a full document', () => {
  // `get_text` returns a fragment, but a captured page is a whole document, and
  // the two need different parsing. An earlier version handled only fragments and
  // returned `<!DOCTYPE html>` and nothing else for a full page — silently, with no
  // error, which is the worst way for an anonymiser to fail.
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<title>A real headline | The Publisher</title></head>
<body><header><a href="/environment">Environment</a></header>
<article><h1>The headline</h1><p>Some prose here.</p>
<img src="/img/hero.jpg" width="800" height="600"></article>
<style>.byline { color: red; }</style>
<script>const tracking = "id-12345";</script></body></html>`;

  const output = anonymizeHtml(page);

  it('does not collapse the document to nothing', () => {
    expect(output.length).toBeGreaterThan(200);
    expect(measure(output).paragraphs).toBe(1);
    expect(measure(output).images).toBe(1);
  });

  it('anonymises the title', () => {
    expect(output).toContain('<title>');
    expect(output).not.toContain('Publisher');
  });

  it('anonymises relative navigation links', () => {
    expect(output).not.toContain('/environment');
  });

  it('leaves script and style contents intact', () => {
    // Substituting letters inside these would corrupt them into something that no
    // longer parses, and neither holds anything worth removing.
    expect(output).toContain('color: red');
    expect(output).toContain('const tracking');
  });

  it('keeps image dimensions', () => {
    expect(output).toContain('width="800"');
    expect(output).toContain('height="600"');
  });
});

describe('measure', () => {
  it('counts the blocks that overflow a column', () => {
    const m = measure('<p>x</p><table></table><iframe></iframe><pre></pre>');
    expect(m.wideBlocks).toBe(3);
    expect(m.paragraphs).toBe(1);
  });

  it('flags a stub as truncated', () => {
    expect(measure('<p>Continue reading</p>').truncated).toBe(true);
  });

  it('does not flag a real article', () => {
    expect(measure(`<p>${'word '.repeat(600)}</p>`).truncated).toBe(false);
  });
});

describe('assignShapes', () => {
  const candidate = (id: number, m: Partial<Measurements>): Candidate => ({
    bookmarkId: id,
    measurements: { chars: 5000, paragraphs: 20, images: 0, wideBlocks: 0, truncated: false, ...m },
  });

  it('claims the scarce paywall shapes before the plentiful ones', () => {
    // A stub must not be spent as the "short" example, leaving the paywall case
    // uncovered — which is why order of assignment matters.
    const assigned = assignShapes([
      candidate(1, { truncated: true, chars: 200 }),
      candidate(2, { chars: 30000 }),
      candidate(3, { chars: 900 }),
    ]);
    expect(assigned.get('soft-paywall')).toBe(1);
    expect(assigned.get('short')).toBe(3);
  });

  /*
   * Two captures in a row put the wrong article in the hard-paywall slot, both by
   * the same rule: `chars === 0`. First a request that had timed out; then — once
   * that was excluded — a page Instapaper had returned 200 and real markup for,
   * which simply had no prose in it.
   *
   * Zero characters has three causes and only one of them is a paywall. Which one it
   * is lives in the response, not in the measurements, so these pin that selection
   * reads the outcome instead of re-deriving it.
   */
  describe('what fills the hard-paywall slot', () => {
    const zero = { chars: 0, paragraphs: 0, images: 0, wideBlocks: 0, truncated: true };

    const withOutcome = (
      id: number,
      outcome: Candidate['outcome'],
      m: Partial<Measurements> = {},
    ): Candidate => ({ bookmarkId: id, measurements: { ...zero, ...m }, outcome });

    it('is a refusal — an error, or an empty body', () => {
      expect(assignShapes([withOutcome(9, 'refused')]).get('hard-paywall')).toBe(9);
    });

    it('is not a request that never completed', () => {
      // A timeout is a fact about the network. It says nothing about the article.
      expect(assignShapes([withOutcome(1, 'unreachable')]).has('hard-paywall')).toBe(false);
    });

    it('is not an article that came back as markup with no prose', () => {
      // The second misfiling: 200, real markup, one wide block, no text — a video
      // page. Instapaper parsed it and gave us what was on it; it refused nothing.
      expect(assignShapes([withOutcome(1, 'article', { wideBlocks: 1 })]).has('hard-paywall')).toBe(
        false,
      );
    });

    it('is the refusal even when both impostors come first', () => {
      // The order both captures failed in: the impostor was earlier in the sample,
      // so `find` took it and the real refusal further down went unused.
      const assigned = assignShapes([
        withOutcome(1, 'unreachable'),
        withOutcome(2, 'article', { wideBlocks: 1 }),
        withOutcome(3, 'refused'),
      ]);
      expect(assigned.get('hard-paywall')).toBe(3);
    });

    it('still lets a prose-free article serve a shape it genuinely has', () => {
      // Excluding it from hard-paywall is not discarding it. A page that is all
      // embed is a real capture and a fair wide-embeds example.
      const assigned = assignShapes([withOutcome(1, 'article', { wideBlocks: 4 })]);
      expect(assigned.get('wide-embeds')).toBe(1);
    });
  });

  describe('a request that never completed', () => {
    const unreachable = (id: number): Candidate => ({
      bookmarkId: id,
      measurements: { chars: 0, paragraphs: 0, images: 0, wideBlocks: 0, truncated: true },
      outcome: 'unreachable',
    });

    it('is excluded from every shape', () => {
      expect(assignShapes([unreachable(1)]).size).toBe(0);
    });

    it('leaves the rest of the sample alone', () => {
      const assigned = assignShapes([
        unreachable(1),
        candidate(2, { chars: 30000, images: 9 }),
        candidate(3, { chars: 12000 }),
        candidate(4, { chars: 600 }),
      ]);
      expect(assigned.get('image-heavy')).toBe(2);
      expect(assigned.get('very-long')).toBe(3);
      expect(assigned.get('short')).toBe(4);
      expect([...assigned.values()]).not.toContain(1);
    });
  });

  it('never assigns one article to two shapes', () => {
    const assigned = assignShapes([
      candidate(1, { images: 10, wideBlocks: 4, chars: 50000 }),
      candidate(2, { images: 5, wideBlocks: 2, chars: 20000 }),
      candidate(3, { chars: 400 }),
    ]);
    expect(new Set(assigned.values()).size).toBe(assigned.size);
  });

  it('omits a shape with no candidate rather than padding it', () => {
    // A set that says a shape is missing is more useful than one containing an
    // article that does not have the property it claims to demonstrate.
    const assigned = assignShapes([candidate(1, { chars: 4000 })]);
    expect(assigned.has('image-heavy')).toBe(false);
    expect(assigned.has('soft-paywall')).toBe(false);
  });

  it('handles no candidates at all', () => {
    expect(assignShapes([]).size).toBe(0);
  });
});

describe('toFixtureBookmark', () => {
  const raw = {
    bookmark_id: 12345,
    title: 'A headline that reveals what someone reads',
    url: 'https://publisher.example/story?utm_source=newsletter&giftLink=TOKEN',
    time: 1700000000,
    description: 'A summary sentence',
    hash: 'abc123',
  };

  const fixture = toFixtureBookmark(raw);

  it('anonymises the title but keeps its length', () => {
    // Phase 5 lays out a hero and three cards; headline length is the thing that
    // makes those slots realistic.
    expect(fixture.title).toHaveLength(raw.title.length);
    expect(fixture.title).not.toContain('someone');
  });

  it('scrubs then anonymises the URL', () => {
    expect(fixture.url).not.toContain('TOKEN');
    expect(fixture.url).not.toContain('publisher');
    expect(new URL(fixture.url).hostname).toBe('example.com');
  });

  it('keeps the fields the app actually reads', () => {
    expect(fixture.bookmark_id).toBe(12345);
    expect(fixture.time).toBe(1700000000);
    expect(fixture.hash).toBe('abc123');
  });

  it('carries no field we never read', () => {
    // The safest treatment of data you do not need is not to have it.
    const withExtras = { ...raw, progress: 0.42, starred: '1', private_source: 'x' };
    expect(Object.keys(toFixtureBookmark(withExtras))).toEqual([
      'bookmark_id',
      'title',
      'url',
      'time',
      'description',
      'hash',
    ]);
  });
});
