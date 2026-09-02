/**
 * Re-extracting an article from the publisher's own page.
 *
 * The second tier of `docs/EXTRACTION.md`: Instapaper's `get_text` is tried first,
 * and when it comes back as a stub — a soft paywall, a script-heavy page, an
 * extractor that gave up — this fetches the source URL and reduces it with
 * Readability instead.
 *
 * Everything dangerous about it was built in Phase 2a and Phase 4 and is reused
 * rather than reimplemented: the same `guardedFetch` with the same SSRF rules,
 * every redirect hop re-validated, the same refusal of `instapaper.com`, the same
 * honest `Stash/0.1 (+repo)` User-Agent. **The posture note in the spec is a
 * constraint, not a preamble** — this never claims to be a crawler, and the only
 * thing it unlocks is a page the reader already has the right to read.
 *
 * Site sessions are attached here in Phase 7b. Until then the fetch is anonymous,
 * which already handles soft paywalls, and the wire behaviour is identical with an
 * empty jar — the safe one-line change the staged order relies on.
 */
import { cleanExtracted } from '../src/lib/cleaners.js';
import { BlockedUrlError, assertFetchable } from '../src/lib/fetch-guard.js';
import { extract } from '../src/lib/extract.js';
import { requireSession } from '../src/lib/guard.js';
import { isTruncated } from '../src/lib/truncation.js';

/** Longer than the image resolver's: this is one article a reader is waiting for. */
export const TIMEOUT_MS = 25_000;

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

export async function GET(request: Request): Promise<Response> {
  const refusal = requireSession(request);
  if (refusal) return refusal;

  const params = new URL(request.url).searchParams;
  const raw = params.get('url');
  if (raw === null || raw.trim() === '') {
    return json({ error: 'bad_request', detail: 'url is required' }, 400);
  }

  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return json({ error: 'bad_request', detail: 'url is not a URL' }, 400);
  }

  // Before the fetch, and visibly so — the same ordering as `api/resolve-image`,
  // for the same reason: a refusal has to be a line you can read.
  try {
    await assertFetchable(target);
  } catch (error) {
    if (error instanceof BlockedUrlError) {
      return json({ error: 'blocked', detail: error.message }, 403);
    }
    throw error;
  }

  const result = await extract(target.toString(), { timeoutMs: TIMEOUT_MS });

  if (!result.ok) {
    /*
     * A failure, not an exception, and it carries its own short tag — "HTTP 403",
     * "Readability returned empty". 200 rather than 5xx because the request was
     * fine and the answer is real: this article cannot be extracted, which is
     * something the client caches and shows, not something it retries at once.
     */
    return json({ url: result.url, ok: false, tag: result.tag, authenticated: false }, 200);
  }

  const html = cleanExtracted(result.html, {
    title: result.title ?? undefined,
    excerpt: params.get('excerpt') ?? undefined,
  });

  /*
   * The verdict travels with the article.
   *
   * Whether the *extraction* is itself a stub is the client's business — it decides
   * whether to keep this or fall back — and it is also the expired-session signal
   * in Phase 7b: extraction succeeded, output still trips the heuristic, and
   * cookies were sent, means the session has almost certainly lapsed.
   */
  const truncation = isTruncated(html);

  return json(
    {
      url: result.url,
      ok: true,
      html,
      title: result.title,
      byline: result.byline,
      chars: result.text.length,
      rawBytes: result.rawBytes,
      redirects: result.redirects,
      authenticated: result.authenticated,
      truncated: truncation.truncated,
      truncationReasons: truncation.reasons,
    },
    200,
  );
}
