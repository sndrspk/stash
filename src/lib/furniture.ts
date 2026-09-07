/**
 * Furniture removal — the one cleaner that runs at **render**, in the browser.
 *
 * It lives apart from its three siblings in `cleaners.ts` for a reason that is
 * about weight rather than about tidiness. Those three run at extraction, inside
 * a serverless function, where there is no DOM and `linkedom` supplies one. This
 * one runs in the reading view, on a phone, in a browser that already has a DOM —
 * and because a bundler follows a module's imports rather than its exports, one
 * `import { removeFurniture } from './cleaners'` in `Reader.tsx` was enough to
 * pull linkedom and its parser stack (htmlparser2, css-select, cssom, domutils,
 * css-what — around 470 KiB unminified) into the client bundle, to do a job the
 * platform does for free.
 *
 * So the split follows the seam the design already had: `cleanExtracted` is
 * documented as extraction-time and stays with linkedom; this is documented as
 * render-time and uses `DOMParser`. Nothing here may import `cleaners.ts`, and
 * nothing here may import linkedom — `test/client-bundle.test.ts` walks the
 * import graph from `main.tsx` and fails if either creeps back.
 *
 * The rule the markers obey is the same one that governs every cleaner: **a
 * signal, never a publisher.** No rule may key on a site's name or domain. A list
 * of hostnames is a list that rots silently and is wrong for every site not on
 * it; a link target or a marker string describes what the thing *is*.
 */
import { plainText } from './truncation.js';

/**
 * A fragment, in a document that actually has a body.
 *
 * `DOMParser` populates `document.body` for a bare fragment, so unlike linkedom
 * it does not need the `<!doctype html>` wrapper. The wrapper is here anyway, and
 * deliberately: it is what makes this parse and the one in `cleaners.ts` receive
 * a byte-identical string. These rules are tuned against saved pages, and a
 * difference in what the parser is handed is a difference that would show up as
 * one publisher's article cleaning differently on the server than in the reader.
 */
function parse(fragment: string): Document {
  return new DOMParser().parseFromString(
    `<!doctype html><html><body>${fragment}</body></html>`,
    'text/html',
  );
}

const serialize = (document: Document): string => document.body.innerHTML;

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
