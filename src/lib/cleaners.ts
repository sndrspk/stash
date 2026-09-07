/**
 * The extraction-time cleaners, ported from SanFeedBin (docs/EXTRACTION.md).
 *
 * Readability gets an article out of a page; it does not get the page out of the
 * article. What is left over is consistent enough to be worth naming: the headline
 * repeated as the first line, an opening paragraph the extractor dropped, a
 * newsletter box or "read this next" block that survived, and a lead photograph
 * that either went missing or was never the lead.
 *
 * Each is a pure function over an HTML fragment, and they are separate rather than
 * one pass because they are individually testable against a saved page — which is
 * the only way to be sure a rule that helps one publisher does not ruin another.
 * That is why this file exports them individually as well as composed.
 *
 * **The fourth cleaner is not here.** Furniture removal runs at render rather than
 * at extraction, which puts it in the browser, and this module reaches for
 * linkedom to get a DOM that a browser already has. Keeping the two together meant
 * shipping a parser stack to the phone for nothing, so it lives in `furniture.ts`
 * and uses `DOMParser`. The seam is the one the design already described; only the
 * file boundary is new. Nothing under `src/routes`, `src/components` or
 * `src/hooks` may import this module — `test/client-bundle.test.ts` enforces it.
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

/**
 * Words a publisher uses to mark the standfirst — the paragraph between the headline
 * and the body, set larger, that summarises the piece.
 *
 * A signal, never a publisher: these are the vocabulary of newsroom CMSs, not a list of
 * sites. `standfirst` is British, `dek` American, `chapeau` French and Dutch, `perex`
 * Czech and Slovak, `lead`/`lede` and `intro` international. A site not on this list
 * that uses one of these words is handled; a site on it that renames its classes stops
 * being handled, which is the failure mode a domain list does not have — and is exactly
 * why the domain list is still the wrong trade. This one is wrong quietly and rarely;
 * a hostname list is wrong silently for every site that is not on it.
 */
export const LEDE_MARKERS: readonly string[] = [
  'standfirst',
  'intro',
  'lede',
  'lead',
  'chapeau',
  'perex',
  'dek',
];

/** Longest a standfirst can be. Past this it is the article, not a summary of it. */
export const MAX_LEDE_CHARS = 1500;

/** And shortest. Below this it is a label — "Analysis", "5 min read" — not prose. */
export const MIN_LEDE_CHARS = 40;

/** Above this share of linked text, the block is navigation dressed as prose. */
export const MAX_LEDE_LINK_DENSITY = 0.25;

/**
 * The identifying words in an attribute, as whole tokens.
 *
 * Substring matching cannot be used here and the reason is worth recording: the Dutch
 * `ontdek-meer` ("discover more") contains `dek`, and `leaderboard` contains `lead`. A
 * CSS-module class arrives as `story-intro_storyIntro__7SJ5Q`, so the split has to
 * handle camelCase as well as separators — `storyIntro` must yield `intro` or the
 * hashed half of every modern class name is invisible to this.
 */
function attributeTokens(value: string): Set<string> {
  return new Set(
    value
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .split(/[^A-Za-z]+/)
      .filter(Boolean)
      .map((token) => token.toLowerCase()),
  );
}

/**
 * The text, with element boundaries treated as spaces.
 *
 * Not `textContent`, and the difference is visible in the reading view rather than
 * theoretical: a standfirst routinely opens with a dateline in its own element —
 * `<span>BRUSSEL</span>Anderlecht moet…` — and `textContent` concatenates the two into
 * `BRUSSELAnderlecht`. `plainText` replaces each tag with a space before collapsing
 * runs, so the boundary survives as the word break it looks like on the page.
 */
function visibleText(element: Element): string {
  return plainText(element.innerHTML);
}

function linkDensity(element: Element): number {
  const total = visibleText(element).length;
  if (total === 0) return 1;
  let linked = 0;
  for (const anchor of element.querySelectorAll('a')) linked += visibleText(anchor).length;
  return linked / total;
}

/**
 * The article's standfirst, from the *source page*, or nothing.
 *
 * Why this exists at all: Readability finds the container with the highest density of
 * paragraphs and returns that. A standfirst is routinely a single `<h2>` in a
 * `<hgroup>` beside the body rather than inside it — headline, standfirst, byline, date
 * — and that group scores nothing, because Readability discounts headings and there is
 * only one block of prose in it. So the opening paragraph of the article is dropped,
 * every time, on every article that publisher runs, and the extraction otherwise looks
 * perfect.
 *
 * This is deliberately not one of the fragment cleaners. It needs the page as fetched,
 * and it must run **before** `Readability.parse`, which mutates the document it is
 * given — by the time there is a fragment to clean, the standfirst has been stripped
 * from the DOM it would have been recovered from.
 *
 * Returns plain text rather than markup, for the same reason `restoreMissingIntro`
 * does: what comes back is prose being restored, not a publisher's heading markup being
 * merged into the reading view.
 */
export function findLede(document: Document): string | null {
  const scope = document.querySelector('article, main') ?? document.body;
  if (scope === null) return null;

  for (const element of scope.querySelectorAll('[data-testid], [class], [id], [itemprop]')) {
    const attributes = [
      element.getAttribute('data-testid') ?? '',
      element.getAttribute('class') ?? '',
      element.getAttribute('id') ?? '',
      element.getAttribute('itemprop') ?? '',
    ].join(' ');

    const tokens = attributeTokens(attributes);
    if (!LEDE_MARKERS.some((marker) => tokens.has(marker))) continue;

    const text = visibleText(element);
    if (text.length < MIN_LEDE_CHARS || text.length > MAX_LEDE_CHARS) continue;
    if (linkDensity(element) > MAX_LEDE_LINK_DENSITY) continue;

    // First match in document order, and only the first: a page with two of these has
    // a standfirst and something else, and the standfirst is the one at the top.
    return text;
  }

  return null;
}

/**
 * Put the standfirst back, unless the extraction already has it.
 *
 * The guard is the whole of it. Plenty of publishers mark up a standfirst *inside* the
 * body, where Readability keeps it — prepending there would print the article's opening
 * paragraph twice, which is a worse outcome than the bug this fixes and a good deal
 * harder to notice in testing, because it looks like the publisher's own repetition.
 *
 * Compared on normalised words rather than on the string, since Readability rewrites
 * whitespace and entities on its way out.
 */
export function restoreLede(fragment: string, lede: string | null): string {
  if (lede === null || lede.trim() === '') return fragment;

  const wanted = normalizeTitle(lede);
  if (wanted === '') return fragment;

  // The opening of the extraction, generously bounded: a standfirst that survived is at
  // the top of it, and searching the whole article would match a later restatement.
  const opening = normalizeTitle(plainText(fragment).slice(0, Math.max(2000, lede.length * 4)));
  const probe = wanted.slice(0, 80);
  if (probe !== '' && opening.includes(probe)) return fragment;

  return `<p>${escapeText(lede)}</p>${fragment}`;
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
