/**
 * Fetch a page and reduce it to an article fragment.
 *
 * Ported from SanFeedBin's ContentExtractor (docs/EXTRACTION.md). Every failure mode
 * collapses into one result type, so the caller has exactly one thing to handle. Non-2xx,
 * an empty body and empty Readability output are ordinary failures, not exceptions.
 */

import { Readability } from '@mozilla/readability';
import { parseHTML } from 'linkedom';
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
  try {
    const { document } = parseHTML(withBase(html, url));
    article = new Readability(document as unknown as Document).parse();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, url, tag: tag(`Readability failed: ${message}`), authenticated };
  }

  const content = article?.content ?? '';
  if (content.trim() === '') {
    return { ok: false, url, tag: 'Readability returned empty', authenticated };
  }

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
    text: article?.textContent?.trim() ?? plainText(content),
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
