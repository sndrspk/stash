/**
 * What goes where on the front page.
 *
 * The layout is a newspaper's: one lead story with a picture, three below it with
 * pictures, and two title-only columns of what else is waiting. Which article lands
 * in which slot is the part with rules in it, so it lives here — pure, seeded, and
 * tested against arrays rather than against a rendered page.
 *
 * The rule the spec is emphatic about: **an article with no resolved image is never
 * put in one of the four image slots.** A newspaper does not run a lead story with a
 * blank rectangle where the photograph goes. Such articles are not hidden — they
 * appear in the sidebar lists like anything else.
 */
import type { BookmarkRecord, ImageCacheRecord } from './db.js';

export interface FrontPageSlots {
  /** The lead story, or null when nothing unread has a picture yet. */
  hero: BookmarkRecord | null;
  /** Up to three, and fewer when the queue cannot fill them. */
  secondaries: BookmarkRecord[];
  /** Up to five of each, title-only, and never overlapping each other. */
  newest: BookmarkRecord[];
  oldest: BookmarkRecord[];
  /** How many unread articles the four image slots could have been drawn from. */
  illustrated: number;
}

export const SECONDARY_SLOTS = 3;
export const SIDEBAR_LENGTH = 5;

const EMPTY: FrontPageSlots = {
  hero: null,
  secondaries: [],
  newest: [],
  oldest: [],
  illustrated: 0,
};

/**
 * mulberry32: small, fast, and good enough for choosing four articles.
 *
 * Seeded rather than `Math.random()` so that the same refresh renders the same page
 * on every re-render — the resolution pass writing an image row must not reshuffle
 * the front page under the reader — and so the selection rules can be tested at all.
 */
function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates, on a copy. */
function shuffled<T>(items: readonly T[], next: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/**
 * Whether this article has a picture to put in a slot.
 *
 * `ok` with a URL, and nothing else: `none` means the page genuinely has none,
 * `error` means we do not yet know, and neither can fill a slot. An unresolved
 * article is simply not a candidate — it becomes one when its row arrives.
 */
export function hasImage(row: ImageCacheRecord | undefined): boolean {
  return row?.status === 'ok' && typeof row.image_url === 'string' && row.image_url !== '';
}

/**
 * Fills the slots.
 *
 * The sidebar lists deliberately **exclude the four articles already on show**, and
 * never repeat each other. A front page that runs its lead story again halfway down
 * the sidebar has spent one of its ten remaining rows saying nothing; the lists are
 * there for what the slots did not cover. Where the two lists would overlap — fewer
 * than ten articles left — `newest` is filled first and `oldest` takes what remains,
 * so the same article is never printed twice.
 */
export function chooseSlots(
  unread: readonly BookmarkRecord[],
  images: ReadonlyMap<string, ImageCacheRecord>,
  seed: number,
): FrontPageSlots {
  if (unread.length === 0) return { ...EMPTY };

  const illustrated = unread.filter((bookmark) => hasImage(images.get(bookmark.url)));

  const next = random(seed);
  const picked = shuffled(illustrated, next).slice(0, 1 + SECONDARY_SLOTS);
  const inSlot = new Set(picked.map((bookmark) => bookmark.bookmark_id));

  const rest = unread.filter((bookmark) => !inSlot.has(bookmark.bookmark_id));
  const byTime = [...rest].sort((a, b) => b.time - a.time);

  const newest = byTime.slice(0, SIDEBAR_LENGTH);
  const claimed = new Set(newest.map((bookmark) => bookmark.bookmark_id));
  const oldest = byTime
    .filter((bookmark) => !claimed.has(bookmark.bookmark_id))
    .slice(-SIDEBAR_LENGTH)
    .reverse();

  return {
    hero: picked[0] ?? null,
    secondaries: picked.slice(1),
    newest,
    oldest,
    illustrated: illustrated.length,
  };
}

// --- excerpts ---

/** Long enough to be a paragraph, short enough not to become the article. */
export const HERO_EXCERPT_CHARS = 260;
export const CARD_EXCERPT_CHARS = 150;

/** Tags whose contents are not prose and must not become an excerpt. */
const NOT_PROSE = /<(script|style|figcaption|noscript)\b[^>]*>[\s\S]*?<\/\1>/gi;

/**
 * Article HTML reduced to a plain-text excerpt.
 *
 * Cut on a word boundary, and preferably on a sentence: a paragraph that stops
 * mid-word reads as a bug, and one that ends on a full stop reads as an edit. The
 * ellipsis is added only when something was actually removed.
 */
export function deriveExcerpt(html: string, maxChars: number): string {
  const text = html
    .replace(NOT_PROSE, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();

  if (text.length <= maxChars) return text;

  const window = text.slice(0, maxChars + 1);

  // A sentence ending in the last third of the window: prefer it to a word cut.
  const sentence = /[.!?][)"'”’]?\s/g;
  let sentenceEnd = -1;
  for (let match = sentence.exec(window); match !== null; match = sentence.exec(window)) {
    if (match.index >= maxChars * 0.6) sentenceEnd = match.index + match[0].trimEnd().length;
  }
  if (sentenceEnd > 0) return window.slice(0, sentenceEnd);

  const space = window.lastIndexOf(' ');
  const cut = space > 0 ? space : maxChars;
  return `${text.slice(0, cut).replace(/[\s,;:—–-]+$/, '')}…`;
}

/**
 * The excerpt for one article.
 *
 * `description` first, because Instapaper already has it and it costs nothing —
 * which is also why only the four slot articles ever fetch text: everything else on
 * the page is title-only and would be paying for prose it never shows.
 */
export function excerptFor(
  bookmark: BookmarkRecord,
  html: string | undefined,
  maxChars: number,
): string {
  const described = bookmark.description.trim();
  if (described !== '') return deriveExcerpt(described, maxChars);
  if (html !== undefined && html.trim() !== '') return deriveExcerpt(html, maxChars);
  return '';
}

/** Which slot articles still need their text fetched to have anything to show. */
export function needsExcerptText(slots: FrontPageSlots): BookmarkRecord[] {
  const inSlots = [slots.hero, ...slots.secondaries].filter(
    (bookmark): bookmark is BookmarkRecord => bookmark !== null,
  );
  return inSlots.filter((bookmark) => bookmark.description.trim() === '');
}
