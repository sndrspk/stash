/**
 * Choosing one representative image for an article page.
 *
 * Instapaper bookmarks carry no thumbnail field, so the front page's four image
 * slots are filled by fetching each article's own source URL and reading what the
 * publisher declared. That is the whole of Phase 4: this file decides *which* image,
 * `api/resolve-image` does the fetching, and `images.ts` decides *when*.
 *
 * Pure and network-free on purpose. Which image a page yields is the part with
 * judgement in it, so it is testable against a string rather than a site.
 */
import { parseHTML } from 'linkedom';

/** Where the chosen URL came from. Returned for diagnosis, not for logic. */
export type ImageOrigin = 'og:image' | 'twitter:image' | 'link:image_src' | 'img' | 'none';

export interface ImagePick {
  imageUrl: string | null;
  from: ImageOrigin;
}

const NOTHING: ImagePick = { imageUrl: null, from: 'none' };

/**
 * Declared images, best first.
 *
 * `og:image:secure_url` and `og:image:url` are the same picture as `og:image` in
 * the rare pages that set them, and they sort ahead because the plain tag is
 * sometimes left pointing at a stale CDN host when the others are maintained.
 * `twitter:image` and `link rel="image_src"` are the older spellings of the same
 * intent, and cost one attribute lookup each to support.
 */
const META_KEYS: readonly (readonly [string, ImageOrigin])[] = [
  ['og:image:secure_url', 'og:image'],
  ['og:image:url', 'og:image'],
  ['og:image', 'og:image'],
  ['twitter:image', 'twitter:image'],
  ['twitter:image:src', 'twitter:image'],
];

/**
 * Only ever how many `<img>` elements are considered.
 *
 * A gallery page can carry hundreds, and past the first handful they are thumbnails
 * of other articles rather than this one. The cap also bounds the work done on a
 * hostile page.
 */
const MAX_IMG_SCANNED = 40;

/**
 * Below this, in either dimension, an `<img>` is furniture: a tracking pixel, a
 * share icon, an author avatar. Only applied when the element actually declares a
 * size — a missing `width` says nothing, and treating it as small would reject most
 * real photographs.
 */
const MIN_IMG_DIMENSION = 200;

/**
 * Filename fragments that mean "not the article's picture".
 *
 * Matched against the path only, so a publisher whose domain happens to contain one
 * of these words is unaffected. This is a heuristic and it is allowed to be wrong
 * occasionally: the cost of a bad guess is one dull thumbnail, and the front page
 * excludes image-less articles from its four slots anyway.
 */
const FURNITURE = [
  'pixel',
  'spacer',
  'blank',
  '1x1',
  'transparent',
  'avatar',
  'logo',
  'icon',
  'sprite',
  'badge',
  'emoji',
  'beacon',
  'tracking',
  'placeholder',
];

/** Attributes a lazy-loading `<img>` hides its real source in, in order of trust. */
const LAZY_SRC_ATTRS = ['src', 'data-src', 'data-original', 'data-lazy-src', 'data-hi-res-src'];
const LAZY_SRCSET_ATTRS = ['srcset', 'data-srcset', 'data-lazy-srcset'];

/**
 * Absolute `http`/`https` URL, or null.
 *
 * Everything else is discarded here rather than downstream: `data:` URIs are
 * placeholders, `javascript:` is an attack, and a protocol-relative `//host/x`
 * resolves correctly against the base without special handling.
 */
function absolute(value: string | null | undefined, base: string): string | null {
  const raw = value?.trim();
  if (raw === undefined || raw === '') return null;
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url.toString();
}

/** The largest candidate in a `srcset`, by its width or density descriptor. */
function fromSrcset(value: string | null | undefined, base: string): string | null {
  if (!value) return null;

  let best: { url: string; weight: number } | null = null;
  for (const entry of value.split(',')) {
    const parts = entry.trim().split(/\s+/);
    const candidate = parts[0];
    if (candidate === undefined || candidate === '') continue;

    const descriptor = parts[1] ?? '1x';
    const magnitude = Number.parseFloat(descriptor);
    // A `w` descriptor is a pixel width and an `x` one a density: they are not
    // comparable, but a srcset never mixes them, so ranking within one is enough.
    const weight = Number.isFinite(magnitude) ? magnitude : 1;

    const url = absolute(candidate, base);
    if (url !== null && (best === null || weight > best.weight)) best = { url, weight };
  }
  return best?.url ?? null;
}

function looksLikeFurniture(url: string): boolean {
  let path: string;
  try {
    path = new URL(url).pathname.toLowerCase();
  } catch {
    return true;
  }
  // SVG is drawn, not photographed: in practice it is a logo or an icon every time.
  if (path.endsWith('.svg')) return true;
  return FURNITURE.some((word) => path.includes(word));
}

/** A declared dimension small enough to prove the element is not the photograph. */
function declaredTooSmall(element: Element): boolean {
  for (const attribute of ['width', 'height']) {
    const raw = element.getAttribute(attribute);
    if (raw === null) continue;
    const value = Number.parseInt(raw, 10);
    if (Number.isFinite(value) && value > 0 && value < MIN_IMG_DIMENSION) return true;
  }
  return false;
}

/** The base every relative URL on the page resolves against. */
function baseUrl(document: Document, pageUrl: string): string {
  const declared = document.querySelector('base[href]')?.getAttribute('href');
  return absolute(declared, pageUrl) ?? pageUrl;
}

/** `<meta property="og:image">`, tolerating the `name=` spelling publishers also use. */
function metaContent(document: Document, key: string): string | null {
  const escaped = key.replace(/"/g, '\\"');
  const element =
    document.querySelector(`meta[property="${escaped}" i]`) ??
    document.querySelector(`meta[name="${escaped}" i]`);
  return element?.getAttribute('content') ?? null;
}

/**
 * The page's own picture, or null when it has none.
 *
 * Declared images win outright and are taken at face value: a publisher that says
 * `og:image` has chosen the picture that represents the article, and second-guessing
 * that with the furniture filter would reject the many sites whose social card is
 * their masthead. The `<img>` fallback gets the filter precisely because nobody
 * chose it — it is the first thing in the document, which on a badly built page is a
 * tracking pixel.
 */
export function pickImage(html: string, pageUrl: string): ImagePick {
  if (html.trim() === '') return NOTHING;

  let document: Document;
  try {
    ({ document } = parseHTML(html) as unknown as { document: Document });
  } catch {
    return NOTHING;
  }

  const base = baseUrl(document, pageUrl);

  for (const [key, origin] of META_KEYS) {
    const url = absolute(metaContent(document, key), base);
    if (url !== null) return { imageUrl: url, from: origin };
  }

  const linked = absolute(
    document.querySelector('link[rel="image_src" i]')?.getAttribute('href'),
    base,
  );
  if (linked !== null) return { imageUrl: linked, from: 'link:image_src' };

  const images = Array.from(document.querySelectorAll('img')).slice(0, MAX_IMG_SCANNED);
  for (const image of images) {
    if (declaredTooSmall(image)) continue;

    let candidate: string | null = null;
    for (const attribute of LAZY_SRC_ATTRS) {
      candidate = absolute(image.getAttribute(attribute), base);
      if (candidate !== null) break;
    }
    // A lazy-loaded image's `src` is a placeholder and its real URL is in the
    // srcset, so the srcset is consulted whether or not a src was usable.
    if (candidate === null || looksLikeFurniture(candidate)) {
      for (const attribute of LAZY_SRCSET_ATTRS) {
        const fromSet = fromSrcset(image.getAttribute(attribute), base);
        if (fromSet !== null && !looksLikeFurniture(fromSet)) {
          candidate = fromSet;
          break;
        }
      }
    }

    if (candidate !== null && !looksLikeFurniture(candidate)) {
      return { imageUrl: candidate, from: 'img' };
    }
  }

  return NOTHING;
}
