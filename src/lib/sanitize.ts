/**
 * Cleaning article HTML, immediately before it enters the document.
 *
 * `api/text` returns what Instapaper returned, unmodified, and says why: sanitising
 * belongs at the point of injection, not of transport. This is that point. Nothing
 * else in Stash calls `dangerouslySetInnerHTML`, so this file and the reading view
 * are the whole trust boundary.
 *
 * The content is third-party twice over — a publisher's markup, passed through
 * Instapaper's extractor — and Phase 7 will add a third source that is a publisher's
 * page with no extractor in front of it at all. So the rule here is an **allowlist**:
 * anything not named survives only as its text. A denylist would have to anticipate
 * every future way to smuggle script into markup, which is not a game worth playing
 * against a corpus nobody controls.
 */
import DOMPurify from 'dompurify';

/**
 * What an article is made of.
 *
 * Generous about structure, because the reading view's whole job is to render
 * someone else's prose faithfully — headings, quotes, figures, tables and code all
 * appear in real articles and all have a rendering here. Silent about anything that
 * can execute, load, or navigate on its own.
 */
const ALLOWED_TAGS = [
  'p',
  'br',
  'hr',
  'div',
  'span',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'strong',
  'b',
  'em',
  'i',
  'u',
  's',
  'del',
  'ins',
  'mark',
  'small',
  'sub',
  'sup',
  'a',
  'blockquote',
  'q',
  'cite',
  'ul',
  'ol',
  'li',
  'dl',
  'dt',
  'dd',
  'figure',
  'figcaption',
  'img',
  'picture',
  'source',
  'table',
  'thead',
  'tbody',
  'tfoot',
  'tr',
  'th',
  'td',
  'caption',
  'colgroup',
  'col',
  'pre',
  'code',
  'kbd',
  'samp',
  'var',
  'abbr',
  'time',
  'address',
  'article',
  'section',
  'aside',
  'header',
  'footer',
];

/**
 * Attributes worth keeping.
 *
 * `width` and `height` earn their place: an image that declares its dimensions can
 * be measured before it loads, and the column count depends on measuring the article
 * correctly. `srcset`/`sizes` likewise — a phone should not download the desktop
 * crop. No `style`: a publisher's inline CSS would fight the reader's own typography
 * settings, which are the point of this screen.
 */
const ALLOWED_ATTR = [
  'href',
  'title',
  'alt',
  'src',
  'srcset',
  'sizes',
  'width',
  'height',
  'loading',
  'colspan',
  'rowspan',
  'headers',
  'scope',
  'span',
  'datetime',
  'cite',
  'lang',
  'dir',
  'type',
  'start',
  'reversed',
  'value',
];

/**
 * Turns third-party article HTML into a fragment that is safe to inject.
 *
 * Two hardening steps beyond the allowlists:
 *
 * - **`data:` and every other exotic scheme are refused on links and images**, so
 *   only `http`, `https` and the protocol-relative form survive. DOMPurify allows
 *   `data:` on `<img>` and friends by default, and `data:image/svg+xml` can carry
 *   script — an article has no need of either.
 * - **Every link leaves the app.** Anchors open in a new tab with
 *   `rel="noopener noreferrer"`. Without it a publisher's link would navigate the
 *   PWA itself away from the reading view — losing the reader's position, and in an
 *   installed app with no address bar, stranding them on a page with no way back.
 *
 * Both are enforced in one `afterSanitizeAttributes` hook rather than through
 * `ALLOWED_URI_REGEXP`, and the difference is not cosmetic: that option is applied
 * to **every** attribute value, not only URL-bearing ones, so a strict URL pattern
 * silently strips `width="1200"`, `scope="col"` and `colspan="2"` as well — while
 * still leaving `data:` allowed on images, because DOMPurify checks that separately.
 * It looked like it was working and was wrong in both directions.
 */
export function sanitizeArticle(html: string): string {
  if (html.trim() === '') return '';

  /*
   * Fail closed.
   *
   * Without a DOM to parse into, DOMPurify reports itself unsupported and its
   * `sanitize` returns the input **unchanged** — which at a trust boundary is the
   * worst possible default, because it looks like it worked. An empty article is a
   * visible bug someone fixes; an unsanitised one is not.
   */
  if (!DOMPurify.isSupported) return '';

  DOMPurify.addHook('afterSanitizeAttributes', enforceUrlPolicy);
  try {
    return DOMPurify.sanitize(html, {
      ALLOWED_TAGS,
      ALLOWED_ATTR,
      // An article is a fragment. Returning a whole document would put <html> and
      // <body> inside the multi-column box, which is not markup we can lay out.
      WHOLE_DOCUMENT: false,
      // Keep the text of a dropped element. A stripped <video> that takes its
      // <figcaption> sibling's meaning with it is a worse article than one with a
      // caption and no video.
      KEEP_CONTENT: true,
    });
  } finally {
    // Removed rather than left registered: the hook is global to DOMPurify, and a
    // later caller sanitising something that is not an article should not silently
    // inherit our link policy.
    DOMPurify.removeHook('afterSanitizeAttributes');
  }
}

/** `http`, `https`, protocol-relative, or a fragment. Nothing else. */
const SAFE_URL = /^(?:https?:\/\/|\/\/|\/|#)/i;

function enforceUrlPolicy(node: Element): void {
  for (const attribute of ['href', 'src']) {
    const value = node.getAttribute(attribute);
    if (value !== null && !SAFE_URL.test(value.trim())) node.removeAttribute(attribute);
  }

  /*
   * A srcset is a list, and the browser is free to choose any candidate — so one
   * bad entry is as dangerous as a bad `src`. Filtered rather than dropped whole,
   * which is the safer *and* the more useful choice: a `<picture>` whose `<source>`
   * lost its whole srcset contributes nothing, and if that was the article's lead
   * photograph the reader gets a blank where it should be.
   */
  const srcset = node.getAttribute('srcset');
  if (srcset !== null) {
    const kept = srcset
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => SAFE_URL.test(entry.split(/\s+/)[0] ?? ''));
    if (kept.length === 0) node.removeAttribute('srcset');
    else node.setAttribute('srcset', kept.join(', '));
  }

  if (node.tagName === 'A' && node.hasAttribute('href')) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
}
