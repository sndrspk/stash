/**
 * Turning a real Instapaper account into fixtures that are safe to commit.
 *
 * Two problems the work plan's "scrub before committing" line gestures at without
 * naming:
 *
 * 1. **Privacy.** The bookmark list is a record of what someone reads. Titles and
 *    URLs are the personal part, and they land in a public repository.
 * 2. **Copyright.** `get_text` returns publishers' article prose. Committing that
 *    verbatim to a public repo is a question nobody needs to have.
 *
 * Both are answered the same way: the fixtures keep **structure** and discard
 * **content**. Every tag, attribute, nesting depth, paragraph count, image
 * dimension and character length survives; every word is replaced with filler of
 * the same shape. That is not a lossy compromise for what these fixtures are for —
 * Phase 5's slot selection and Phase 6's column arithmetic care about how much
 * text there is and how it is marked up, never about what it says.
 *
 * Raw captures stay out of the repository entirely; see `scripts/capture.ts`.
 */
import { parseHTML } from 'linkedom';

import { isTruncated, plainText } from './truncation.js';

// --- URL scrubbing ---

/**
 * Query parameters that identify a person or a campaign rather than a document.
 *
 * These ride along on saved links constantly, and several encode where the reader
 * came from — which is exactly the sort of thing that should not be published.
 */
export const TRACKING_PARAMS = [
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_term',
  'utm_content',
  'utm_id',
  'utm_name',
  'fbclid',
  'gclid',
  'gclsrc',
  'dclid',
  'msclkid',
  'igshid',
  'mc_cid',
  'mc_eid',
  'ref',
  'referrer',
  'source',
  'shared_from',
  'share_id',
  'giftLink',
  'unlocked_article_code',
  'smid',
  'sh',
  's',
  't',
  'si',
] as const;

const TRACKING = new Set<string>(TRACKING_PARAMS);

/**
 * Removes tracking parameters, credentials and fragments from a URL.
 *
 * `giftLink` and `unlocked_article_code` matter more than the analytics ones: those
 * are bearer tokens that grant paywall access, tied to the reader's subscription.
 * Publishing one gives it away.
 */
export function scrubUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return raw;
  }

  for (const name of [...url.searchParams.keys()]) {
    if (TRACKING.has(name) || TRACKING.has(name.toLowerCase())) url.searchParams.delete(name);
  }

  // Credentials in a URL are rare and always a mistake to publish.
  url.username = '';
  url.password = '';
  url.hash = '';

  return url.toString();
}

// --- Shape classification ---

export interface Measurements {
  chars: number;
  paragraphs: number;
  images: number;
  /** Tables, iframes and pre blocks together: the things that overflow a column. */
  wideBlocks: number;
  truncated: boolean;
}

export function measure(html: string): Measurements {
  const { document } = parseHTML(`<body>${html}</body>`);
  const count = (selector: string) => document.querySelectorAll(selector).length;

  return {
    chars: plainText(html).length,
    paragraphs: count('p'),
    images: count('img'),
    wideBlocks: count('table') + count('iframe') + count('pre') + count('video'),
    truncated: isTruncated(html).truncated,
  };
}

/** The six shapes the work plan asks for, in the order they are assigned. */
export const SHAPES = [
  'soft-paywall',
  'hard-paywall',
  'image-heavy',
  'wide-embeds',
  'very-long',
  'short',
] as const;

export type Shape = (typeof SHAPES)[number];

export interface Candidate {
  bookmarkId: number;
  measurements: Measurements;
}

/**
 * Picks one representative article per shape.
 *
 * Order matters. The two paywall shapes are claimed first because they are
 * identified by a property nothing else can stand in for — `get_text` gave up —
 * whereas "image-heavy" or "short" can be satisfied by many articles. Assigning the
 * scarce shapes first stops a stub being spent as the "short" example and leaving
 * the paywall case uncovered.
 *
 * A shape with no candidate is simply absent from the result. A fixture set that
 * says so is more useful than one padded with an article that does not have the
 * property it claims to demonstrate.
 */
export function assignShapes(candidates: readonly Candidate[]): Map<Shape, number> {
  const assigned = new Map<Shape, number>();
  const taken = new Set<number>();

  const claim = (shape: Shape, pick: (available: Candidate[]) => Candidate | undefined) => {
    const available = candidates.filter((c) => !taken.has(c.bookmarkId));
    const chosen = pick(available);
    if (chosen) {
      assigned.set(shape, chosen.bookmarkId);
      taken.add(chosen.bookmarkId);
    }
  };

  const best = (available: Candidate[], score: (m: Measurements) => number) =>
    available.reduce<Candidate | undefined>(
      (top, c) => (!top || score(c.measurements) > score(top.measurements) ? c : top),
      undefined,
    );

  // A stub: get_text returned something, but the heuristic says it is not an
  // article. The longest such stub is the most representative.
  claim('soft-paywall', (a) =>
    best(
      a.filter((c) => c.measurements.truncated && c.measurements.chars > 0),
      (m) => m.chars,
    ),
  );

  // Nothing at all came back — the hardest case, and the one that must fail with a
  // legible tag rather than an exception.
  claim('hard-paywall', (a) => a.find((c) => c.measurements.chars === 0));

  claim('image-heavy', (a) =>
    best(
      a.filter((c) => c.measurements.images >= 3),
      (m) => m.images,
    ),
  );
  claim('wide-embeds', (a) =>
    best(
      a.filter((c) => c.measurements.wideBlocks >= 1),
      (m) => m.wideBlocks,
    ),
  );
  claim('very-long', (a) =>
    best(
      a.filter((c) => !c.measurements.truncated),
      (m) => m.chars,
    ),
  );

  // Shortest article that is still a real article, so the reading view has a case
  // with fewer columns than the viewport can show.
  claim('short', (a) => {
    const real = a.filter((c) => !c.measurements.truncated && c.measurements.chars > 0);
    return real.reduce<Candidate | undefined>(
      (low, c) => (!low || c.measurements.chars < low.measurements.chars ? c : low),
      undefined,
    );
  });

  return assigned;
}

// --- Anonymisation ---

const POOL = (
  'lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor ' +
  'incididunt ut labore et dolore magna aliqua enim ad minim veniam quis nostrud ' +
  'exercitation ullamco laboris nisi aliquip ex ea commodo consequat duis aute irure'
).split(' ');

const byLength = new Map<number, string[]>();
for (const word of POOL) {
  const list = byLength.get(word.length) ?? [];
  list.push(word);
  byLength.set(word.length, list);
}

/**
 * A filler word of exactly `length` characters.
 *
 * Length is matched rather than approximated because these fixtures exist to
 * exercise layout: Phase 6 computes a column count from the rendered height of the
 * text, so an anonymised article that is 20% shorter would silently test a
 * different case from the one that was captured.
 */
function filler(length: number, seed: number): string {
  const exact = byLength.get(length);
  if (exact) return exact[seed % exact.length]!;

  let out = '';
  while (out.length < length) out += POOL[(seed + out.length) % POOL.length]!;
  return out.slice(0, length);
}

/**
 * Replaces every run of letters with filler of the same length, preserving case
 * pattern, punctuation, digits and whitespace exactly.
 *
 * Working at the letter-run level rather than the word level means sentence shape,
 * hyphenation, quote marks and line breaks all survive untouched — the markup and
 * typography are the point, and only the words are the liability.
 */
export function anonymizeText(text: string, seed = 0): string {
  let n = seed;
  return text.replace(/[A-Za-z]+/g, (run) => {
    const word = filler(run.length, n++);
    return [...run]
      .map((char, i) => (char === char.toUpperCase() ? word[i]!.toUpperCase() : word[i]!))
      .join('');
  });
}

/** Attributes that carry a URL and therefore a publisher's identity. */
const URL_ATTRS = ['href', 'src', 'srcset', 'poster', 'data-src', 'content'];

/**
 * Rewrites a document so it keeps its structure and loses its content.
 *
 * Attribute URLs become `example.com` equivalents that preserve the path depth and
 * file extension, because Phase 4's image resolution and Phase 6's media clamping
 * both branch on what a URL looks like. Dimensions are kept verbatim: an image's
 * declared width is exactly the sort of thing that breaks a column.
 */
export function anonymizeHtml(html: string): string {
  /*
   * Two input shapes, and they need different handling.
   *
   * `get_text` returns a **fragment**, and linkedom parses a fragment as a sibling
   * of `<body>` inside `documentElement` — so `document.body.innerHTML` is
   * reliably empty and reading it silently returns nothing. A container element we
   * make ourselves puts the nodes where the DOM API says they are.
   *
   * A **full document** is the opposite: `innerHTML` on a `div` discards
   * `<html>`, `<head>` and `<body>` outright, so a whole page would come back as
   * almost nothing. Those parse correctly as documents, and round-trip through
   * `toString()`.
   */
  const isDocument = /^\s*(<!doctype|<html[\s>])/i.test(html);

  if (isDocument) {
    const { document } = parseHTML(html);
    walkAnonymizing(document.documentElement, { n: 0 });
    return document.toString();
  }

  const { document } = parseHTML('<!doctype html><html><body></body></html>');
  const container = document.createElement('div');
  container.innerHTML = html;

  walkAnonymizing(container, { n: 0 });
  return container.innerHTML;
}

/**
 * Elements whose text content is code, not prose.
 *
 * Substituting letters inside a stylesheet or a script would corrupt it into
 * something that no longer parses — and neither contains anything worth removing.
 */
const OPAQUE = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);

function walkAnonymizing(node: unknown, seed: { n: number }): void {
  const parent = node as { childNodes?: Iterable<unknown> };
  for (const child of [...(parent.childNodes ?? [])] as {
    nodeType: number;
    textContent: string | null;
    tagName?: string;
    getAttribute?: (name: string) => string | null;
    setAttribute?: (name: string, value: string) => void;
  }[]) {
    if (child.nodeType === 3) {
      const text = child.textContent ?? '';
      // Whitespace-only nodes are structural; changing them would alter layout.
      if (text.trim()) child.textContent = anonymizeText(text, seed.n++);
      continue;
    }

    if (child.nodeType !== 1) continue;
    if (child.tagName && OPAQUE.has(child.tagName.toUpperCase())) continue;

    for (const attr of URL_ATTRS) {
      const value = child.getAttribute?.(attr);
      if (value) {
        const rewritten = anonymizeUrlLike(value, seed.n);
        if (rewritten !== value) {
          child.setAttribute?.(attr, rewritten);
          seed.n++;
        }
      }
    }
    // alt and title are prose too.
    for (const attr of ['alt', 'title']) {
      const value = child.getAttribute?.(attr);
      if (value) child.setAttribute?.(attr, anonymizeText(value, seed.n++));
    }

    walkAnonymizing(child, seed);
  }
}

/**
 * Anonymises any URL-shaped attribute value, absolute or not.
 *
 * Relative links are the easy thing to miss and they leak just as much: a real
 * article's navigation is full of `/environment`, `/2024/03/the-actual-slug`, and
 * those name the publisher's sections and headlines. An earlier version only
 * rewrote `https?://` values, and the publisher's own words survived in every
 * relative href on the page.
 *
 * `mailto:` is rewritten rather than skipped: a real address in a committed fixture
 * is exactly the kind of thing nobody meant to publish. `tel:`, `data:` and
 * `javascript:` are left alone — the first two carry no letters worth replacing and
 * the third is code that substitution would corrupt — as are bare fragments.
 */
export function anonymizeUrlLike(value: string, seed = 0): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed === '#') return value;

  if (/^mailto:/i.test(trimmed)) return 'mailto:someone@example.com';
  if (/^(tel:|data:|javascript:)/i.test(trimmed)) return value;

  if (/^https?:\/\//i.test(trimmed)) return anonymizeUrl(trimmed, seed);

  // Protocol-relative: //host/path
  if (trimmed.startsWith('//'))
    return anonymizeUrl(`https:${trimmed}`, seed).replace(/^https:/, '');

  // Anything else with letters in it is a path worth scrubbing. It goes through
  // the same segment logic as an absolute URL so that a relative image src keeps
  // its extension too — Phase 4 branches on that.
  if (!/[A-Za-z]/.test(trimmed)) return value;

  const path = trimmed.split(/[?#]/)[0] ?? '';
  const leading = path.startsWith('/') ? '/' : '';
  const trailing = path.length > 1 && path.endsWith('/') ? '/' : '';
  const segments = path.split('/').filter(Boolean);
  if (segments.length === 0) return value;

  return leading + anonymizeSegments(segments, seed).join('/') + trailing;
}

/** Replaces each path segment with filler, keeping length and file extension. */
function anonymizeSegments(segments: readonly string[], seed: number): string[] {
  return segments.map((segment, i) => {
    const dot = segment.lastIndexOf('.');
    // A leading dot is not an extension, and a trailing one has nothing after it.
    if (dot > 0 && dot < segment.length - 1) {
      return `${filler(dot, seed + i)}${segment.slice(dot)}`;
    }
    return filler(Math.max(segment.length, 1), seed + i);
  });
}

/** Keeps path depth and extension, drops the publisher and the slug. */
export function anonymizeUrl(raw: string, seed = 0): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return 'https://example.com/';
  }

  const segments = url.pathname.split('/').filter(Boolean);
  return `https://example.com/${anonymizeSegments(segments, seed).join('/')}`;
}

// --- Bookmark records ---

export interface FixtureBookmark {
  bookmark_id: number;
  title: string;
  url: string;
  time: number;
  description: string;
  hash: string;
}

/**
 * A committable bookmark record.
 *
 * The title and URL are the personal part of a reading list, so both are
 * anonymised: the title keeps its length (Phase 5 needs realistic headline lengths
 * for the hero and card slots) and the URL keeps its shape. Fields Instapaper sends
 * that we never read — `progress`, `starred`, `private_source` — are dropped rather
 * than anonymised, because the safest treatment of data you do not need is not to
 * have it.
 */
export function toFixtureBookmark(raw: FixtureBookmark, seed = 0): FixtureBookmark {
  return {
    bookmark_id: raw.bookmark_id,
    title: anonymizeText(raw.title, seed),
    url: anonymizeUrl(scrubUrl(raw.url), seed),
    time: raw.time,
    description: anonymizeText(raw.description, seed + 100),
    hash: raw.hash,
  };
}

// --- Diagnostics ---

/**
 * Summarises a `bookmarks/list` response without printing anything from it.
 *
 * The point is to distinguish "the folder is empty" from "we did not understand
 * the response" — so it reports the shape and a tally of entry types, and nothing
 * else. Titles and URLs are the personal part; a diagnostic has no business
 * echoing them to a terminal, still less to a bug report.
 */
export function describeResponse(raw: unknown): string {
  if (!Array.isArray(raw)) {
    return `  Response was ${raw === null ? 'null' : typeof raw}, not an array.`;
  }

  if (raw.length === 0) return '  Response was an empty array.';

  const tally = new Map<string, number>();
  for (const item of raw) {
    const type =
      typeof item === 'object' && item !== null
        ? String((item as { type?: unknown }).type ?? '(no type field)')
        : `(${typeof item})`;
    tally.set(type, (tally.get(type) ?? 0) + 1);
  }

  const lines = [...tally].map(([type, count]) => `    ${count} × ${type}`);
  return `  Response had ${raw.length} entries:\n${lines.join('\n')}`;
}
