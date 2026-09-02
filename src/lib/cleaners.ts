/**
 * The four cleaners, ported from SanFeedBin (docs/EXTRACTION.md).
 *
 * Readability gets an article out of a page; it does not get the page out of the
 * article. What is left over is consistent enough to be worth naming: the headline
 * repeated as the first line, an opening paragraph the extractor dropped, a
 * newsletter box or "read this next" block that survived, and a lead photograph
 * that either went missing or was never the lead.
 *
 * Each is a pure function over an HTML fragment, and they are separate rather than
 * one pass for two reasons. They are individually testable against a saved page —
 * which is the only way to be sure a rule that helps one publisher does not ruin
 * another — and **furniture removal runs at render time**, so adding a rule fixes
 * every already-cached article without a re-sync. That is what makes the rule list
 * cheap to grow, and it is the reason this file exports the cleaners individually
 * as well as composed.
 *
 * One rule governs all of them: **a signal, never a publisher.** No rule may key on
 * a site's name or domain. A list of hostnames is a list that rots silently and is
 * wrong for every site not on it; a link target or a marker string describes what
 * the thing *is*.
 */
import { parseHTML } from 'linkedom';

import { plainText } from './truncation.js';

/** How much of a heading must match the title before it counts as a duplicate. */
export const TITLE_SUBSTRING_RATIO = 0.6;

/** Above this share of missing words, the excerpt is a genuinely absent intro. */
export const MISSING_INTRO_RATIO = 0.1;

/**
 * And at least this many missing words, in absolute terms.
 *
 * A deviation from the spec's bare 10%, for a reason that only shows up on real
 * excerpts: a tenth of a fifteen-word excerpt is one and a half words, so an
 * article that merely trimmed a clause — "citing costs that had tripled" against
 * "citing costs" — crosses the threshold and gets its own opening sentence
 * prepended to itself. A genuinely missing intro is missing dozens of words, so the
 * floor costs nothing and stops the duplicate.
 */
export const MIN_MISSING_WORDS = 5;

/** The narrowest image worth promoting to a hero. */
export const MIN_HERO_WIDTH = 600;

/**
 * Punctuation, case and spacing removed, so "Title | Site" and "title—site" compare
 * as the same shape. Deliberately not stemming or transliterating: the comparison
 * is between two spellings of one string, not between two strings.
 */
export function normalizeTitle(value: string): string {
  return value
    .replace(/<[^>]+>/g, ' ')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/**
 * A fragment, in a document that actually has a body.
 *
 * The full `<!doctype html>` wrapper is not decoration: linkedom populates
 * `document.body` only for a complete document, and a bare fragment — or one
 * wrapped in `<body>` alone — parses into a document whose `body.innerHTML` is the
 * empty string. Every cleaner would then quietly return nothing.
 */
function parse(fragment: string): Document {
  const { document } = parseHTML(
    `<!doctype html><html><body>${fragment}</body></html>`,
  ) as unknown as { document: Document };
  return document;
}

const serialize = (document: Document): string => document.body.innerHTML;

/**
 * Remove a leading heading that merely repeats the article's title.
 *
 * Exact after normalisation, or a substring long enough to be the same headline
 * with the site's name bolted on — "Title | Site Name" is the common shape, and
 * comparing on 60% of the *heading* catches it without matching a heading that
 * merely happens to share a few words.
 *
 * Only the first heading, and only near the top: an `<h2>` halfway down that echoes
 * the title is a section break, not a duplicate.
 */
export function removeDuplicateTitle(fragment: string, title: string): string {
  const wanted = normalizeTitle(title);
  if (wanted === '') return fragment;

  const document = parse(fragment);
  const heading = document.querySelector('h1, h2, h3');
  if (heading === null) return fragment;

  /*
   * "Near the top" means no prose precedes it, measured in document order rather
   * than among the body's direct children — a headline is routinely wrapped in a
   * `<header>` or two, and a check that only looked at top-level siblings never
   * found it there and so never removed anything nested.
   */
  const bodyText = document.body.textContent ?? '';
  const headingText = heading.textContent ?? '';
  const at = bodyText.indexOf(headingText);
  if (at > 0 && bodyText.slice(0, at).trim() !== '') return fragment;

  const found = normalizeTitle(heading.textContent ?? '');
  if (found === '') return fragment;

  const duplicate =
    found === wanted ||
    (found.length > 0 &&
      wanted.includes(found) &&
      found.length >= wanted.length * TITLE_SUBSTRING_RATIO) ||
    (found.includes(wanted) && wanted.length >= found.length * TITLE_SUBSTRING_RATIO);

  if (!duplicate) return fragment;

  /*
   * Prune a wrapper the heading leaves empty behind it — a bare `<header>` or
   * `<div>` with nothing in it renders as a stray margin.
   *
   * The parent chain is captured *before* the removal: a detached element has no
   * `parentElement`, so walking up from the heading afterwards finds nothing and
   * the wrappers survive.
   */
  let parent: Element | null = heading.parentElement;
  heading.remove();
  while (parent !== null && parent !== document.body) {
    const grandparent: Element | null = parent.parentElement;
    if (plainText(parent.innerHTML).trim() !== '' || parent.querySelector('img, figure') !== null) {
      break;
    }
    parent.remove();
    parent = grandparent;
  }

  return serialize(document);
}

/**
 * Put back an opening paragraph the extractor dropped.
 *
 * Readability sometimes starts an article at its second paragraph, because the
 * first is marked up as a standfirst or a summary and looks like furniture. The
 * signal is the bookmark's own excerpt: when more than a tenth of its words are
 * absent from the start of what was extracted, the excerpt is saying something the
 * article no longer does.
 *
 * The excerpt is stripped of images, iframes and headings before it is prepended —
 * it is prose being restored, not markup being merged.
 */
export function restoreMissingIntro(fragment: string, excerpt: string): string {
  const intro = plainText(excerpt).trim();
  if (intro === '') return fragment;

  const introWords = new Set(normalizeTitle(intro).split(' ').filter(Boolean));
  if (introWords.size === 0) return fragment;

  // Compared against the *start* of the article, not all of it: an excerpt is drawn
  // from the opening, so finding its words in the final paragraph proves nothing.
  const opening = normalizeTitle(plainText(fragment).slice(0, Math.max(400, intro.length * 3)));
  const present = new Set(opening.split(' ').filter(Boolean));

  let missing = 0;
  for (const word of introWords) if (!present.has(word)) missing += 1;
  if (missing / introWords.size <= MISSING_INTRO_RATIO) return fragment;
  if (missing < MIN_MISSING_WORDS) return fragment;

  const document = parse(excerpt);
  for (const element of document.querySelectorAll('img, picture, iframe, h1, h2, h3, h4, h5, h6')) {
    element.remove();
  }
  const cleaned = plainText(serialize(document)).trim();
  if (cleaned === '') return fragment;

  return `<p>${escapeText(cleaned)}</p>${fragment}`;
}

function escapeText(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * What a furniture block looks like, by what it does rather than by who published
 * it.
 *
 * Each rule is a marker: a phrase that only appears in a promotional block, or a
 * link target that is by definition not article content. A block matches when its
 * *whole* text is short enough to be furniture and carries a marker — the length
 * bound is what stops "subscribe" in the middle of a real paragraph taking the
 * paragraph with it.
 */
export const FURNITURE_MARKERS: readonly string[] = [
  'sign up for our newsletter',
  'subscribe to our newsletter',
  'sign up to our newsletter',
  'read more:',
  'read next:',
  'related articles',
  'related stories',
  'more from',
  'share this article',
  'follow us on',
  'advertisement',
  'this article was originally published',
  'support our journalism',
  'become a member',
  'download the app',
  'accept cookies',
  'enable javascript',
];

/** Longest a block can be and still be furniture rather than prose. */
export const MAX_FURNITURE_CHARS = 400;

/**
 * Remove promotional and navigational blocks left in the article.
 *
 * **Runs at render, not at extraction.** That is the point of it being a separate
 * pass: a marker added next month cleans every article already in the cache,
 * without a re-sync and without invalidating anything. Extraction is expensive and
 * rate-limited; this is a string pass over text we already have.
 */
export function removeFurniture(
  fragment: string,
  markers: readonly string[] = FURNITURE_MARKERS,
): string {
  const document = parse(fragment);

  const candidates = Array.from(
    document.querySelectorAll('p, div, section, aside, ul, ol, figure, header, footer'),
  );

  for (const element of candidates) {
    // Already removed with an ancestor.
    if (element.isConnected === false) continue;

    const text = plainText(element.innerHTML);
    if (text.length > MAX_FURNITURE_CHARS) continue;

    const haystack = text.toLowerCase();
    const marked = markers.some((marker) => haystack.includes(marker));

    // A block whose only content is a link to a subscription or newsletter path is
    // furniture whatever it says.
    const promotionalLink =
      text.length > 0 &&
      element.querySelector(
        'a[href*="/subscribe"], a[href*="/newsletter"], a[href*="/abonnee"]',
      ) !== null &&
      element.querySelectorAll('a').length * 40 >= text.length;

    if (marked || promotionalLink) element.remove();
  }

  return serialize(document);
}

export interface HeroImage {
  src: string;
  alt: string;
}

/**
 * The article's lead photograph, or nothing.
 *
 * Preference order is the spec's: the first image inside a `<figure>`, because a
 * figure is a publisher saying "this is a picture that belongs to the article";
 * then any image that declares itself at least 600px wide. Anything else returns
 * **nothing rather than a guess** — a wrong hero is worse than none, and the front
 * page already has its own resolver for the case where no article image exists.
 */
export function findHeroImage(fragment: string): HeroImage | null {
  const document = parse(fragment);

  const inFigure = document.querySelector('figure img[src]');
  if (inFigure !== null) return toHero(inFigure);

  for (const image of document.querySelectorAll('img[src]')) {
    const width = Number.parseInt(image.getAttribute('width') ?? '', 10);
    if (Number.isFinite(width) && width >= MIN_HERO_WIDTH) return toHero(image);
  }

  return null;
}

function toHero(image: Element): HeroImage {
  return { src: image.getAttribute('src') ?? '', alt: image.getAttribute('alt') ?? '' };
}

export interface CleanOptions {
  title?: string;
  excerpt?: string;
  markers?: readonly string[];
}

/**
 * The cleaners that belong at **extraction** time, in order.
 *
 * Title and intro both compare against metadata that is only to hand when the
 * article is fetched, and neither changes afterwards — so unlike furniture removal
 * there is nothing to gain from re-running them, and a stored fragment is already
 * clean of both.
 */
export function cleanExtracted(fragment: string, { title, excerpt }: CleanOptions = {}): string {
  let out = fragment;
  if (title !== undefined) out = removeDuplicateTitle(out, title);
  if (excerpt !== undefined) out = restoreMissingIntro(out, excerpt);
  return out;
}
