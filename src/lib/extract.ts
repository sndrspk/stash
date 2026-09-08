/**
 * Fetch a page and reduce it to an article fragment.
 *
 * Ported from SanFeedBin's ContentExtractor (docs/EXTRACTION.md). Every failure mode
 * collapses into one result type, so the caller has exactly one thing to handle. Non-2xx,
 * an empty body and empty Readability output are ordinary failures, not exceptions.
 */

import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
import { findLede, restoreLede } from './cleaners.js';
import { domainMatches } from './cookies.js';
import { guardedFetch, BlockedUrlError, type GuardedFetchOptions } from './fetch-guard.js';
import { isTruncated, plainText, type TruncationVerdict } from './truncation.js';

/** Failure tags are short, stable and capped — a column, not a stack trace. */
export const MAX_TAG_LENGTH = 80;

export interface ExtractSuccess {
  ok: true;
  url: string;
  status: number;
  /** Bytes of HTML the publisher served, before extraction. */
  rawBytes: number;
  redirects: number;
  /** Whether a session was replayed for this request. */
  authenticated: boolean;
  title: string | null;
  byline: string | null;
  html: string;
  text: string;
  truncation: TruncationVerdict;
}

export interface ExtractFailure {
  ok: false;
  url: string;
  /** e.g. "HTTP 403", "Readability returned empty", "Network unreachable". */
  tag: string;
  authenticated: boolean;
}

export type ExtractResult = ExtractSuccess | ExtractFailure;

function tag(message: string): string {
  return message.length > MAX_TAG_LENGTH ? `${message.slice(0, MAX_TAG_LENGTH - 1)}…` : message;
}

/**
 * Readability resolves relative URLs against the document's base. linkedom has no
 * document URI to inherit, so give it one explicitly or every image and link in the
 * output comes out relative and broken.
 */
function withBase(html: string, url: string): string {
  if (/<base\b/i.test(html)) return html;
  const base = `<base href="${url.replace(/"/g, '&quot;')}">`;
  if (/<head\b[^>]*>/i.test(html)) return html.replace(/<head\b[^>]*>/i, (m) => `${m}${base}`);
  if (/<html\b[^>]*>/i.test(html))
    return html.replace(/<html\b[^>]*>/i, (m) => `${m}<head>${base}</head>`);
  return `${base}${html}`;
}

/**
 * Did the fetch end up somewhere that could still be the article?
 *
 * A publisher redirects for ordinary reasons — apex to `www`, a country or section
 * host, a canonical path — and all of those stay inside its own domain. A redirect
 * *out* of it is a different event: an SSO host, a consent broker, a login. What comes
 * back then is a real page with a real 200, and it extracts perfectly into a paragraph
 * that says "Inloggen".
 *
 * That is worse than a failure. A failure is visible; a login page stored as the
 * article is a cached article that is wrong, and looks like the publisher's own text
 * until someone reads it.
 *
 * `domainMatches` in both directions is the same RFC 6265 rule the cookie jar uses:
 * `www.knack.be` and `knack.be` are related, `sso.roularta.be` and `www.knack.be` are
 * not. Reusing it means the answer here and the answer about which cookies to send
 * cannot drift apart.
 */
export function reachedSameSite(requested: string, final: string): boolean {
  let a: string;
  let b: string;
  try {
    a = new URL(requested).hostname;
    b = new URL(final).hostname;
  } catch {
    return true; // Not a judgement we can make; do not invent a failure.
  }
  return domainMatches(a, b) || domainMatches(b, a);
}

export interface ExtractOptions extends GuardedFetchOptions {
  /** Present purely so the result can record whether a session was in play. */
  authenticated?: boolean;
}

/**
 * The reduce half, with no network. Split out so the whole pipeline can be exercised
 * against a saved fixture — which is how the cleaners get tested, and how a page that
 * only your browser can reach gets diagnosed.
 */
export function extractFromHtml(html: string, url: string, authenticated = false): ExtractResult {
  if (html.trim() === '') return { ok: false, url, tag: 'Empty body', authenticated };

  let article: ReturnType<Readability['parse']>;
  let lede: string | null;
  try {
    const { document } = parseHTML(withBase(html, url));

    /*
     * Before `parse`, and that ordering is load-bearing rather than tidy.
     *
     * Readability mutates the document it is handed — it strips as it scores — so the
     * `<hgroup>` a standfirst lives in is gone by the time `parse` returns. Reading it
     * afterwards finds nothing, on every page, which looks exactly like a publisher
     * that has no standfirst.
     */
    lede = findLede(document as unknown as Document);
    article = new Readability(document as unknown as Document).parse();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, url, tag: tag(`Readability failed: ${message}`), authenticated };
  }

  const extracted = article?.content ?? '';
  if (extracted.trim() === '') {
    return { ok: false, url, tag: 'Readability returned empty', authenticated };
  }

  // Restored here rather than in `cleanExtracted`, because this is the only layer that
  // still has the source page. `restoreLede` no-ops when the standfirst is already in
  // the body, which is where plenty of publishers put it.
  const content = restoreLede(extracted, lede);

  return {
    ok: true,
    url,
    status: 200,
    rawBytes: Buffer.byteLength(html, 'utf8'),
    redirects: 0,
    authenticated,
    title: article?.title ?? null,
    byline: article?.byline ?? null,
    html: content,
    /*
     * Derived from `content`, not from Readability's own `textContent`, whenever the
     * standfirst was restored — otherwise `text` and `html` disagree about what the
     * article says, and `text` is what the truncation heuristic and the probe report.
     */
    text:
      content === extracted
        ? (article?.textContent?.trim() ?? plainText(content))
        : plainText(content),
    truncation: isTruncated(content),
  };
}

export async function extract(url: string, options: ExtractOptions = {}): Promise<ExtractResult> {
  const authenticated =
    options.authenticated ??
    (options.cookie !== null && options.cookie !== undefined && options.cookie !== '');

  let response;
  try {
    response = await guardedFetch(url, options);
  } catch (error) {
    if (error instanceof BlockedUrlError)
      return { ok: false, url, tag: tag(error.message), authenticated };
    if (error instanceof Error && error.name === 'TimeoutError') {
      return { ok: false, url, tag: 'Timed out', authenticated };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, url, tag: tag(message), authenticated };
  }

  if (response.status < 200 || response.status >= 300) {
    return { ok: false, url: response.url, tag: `HTTP ${response.status}`, authenticated };
  }
  if (!reachedSameSite(url, response.url)) {
    // Named, not generalised: which host it landed on is the whole diagnosis, and it
    // is the difference between "this publisher wants a login" and "our session for
    // it has lapsed".
    let landed = response.url;
    try {
      landed = new URL(response.url).hostname;
    } catch {
      /* keep the whole URL if it will not parse */
    }
    return { ok: false, url: response.url, tag: tag(`Redirected to ${landed}`), authenticated };
  }

  const reduced = extractFromHtml(response.body, response.url, authenticated);
  if (!reduced.ok) return reduced;

  // Carry through what only the fetch knows.
  return {
    ...reduced,
    status: response.status,
    rawBytes: response.bytes,
    redirects: response.redirects,
  };
}
