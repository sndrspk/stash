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
 * Site sessions are attached here. With an empty store the jar sends nothing and the
 * wire behaviour is identical to the anonymous pass — which is what made this the safe
 * one-line change SanFeedBin's staged build order relies on.
 */
import { cleanExtracted } from '../src/lib/cleaners.js';
import { cookieHeaderFor } from '../src/lib/cookies.js';
import { BlockedUrlError, assertFetchable } from '../src/lib/fetch-guard.js';
import { extract } from '../src/lib/extract.js';
import { requireSession } from '../src/lib/guard.js';
import { throttle } from '../src/lib/rate-limit.js';
import { loadJar, openSessionContext } from '../src/lib/site-sessions.js';
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

  const limited = throttle(request, 'extract');
  if (limited) return limited;

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

  /*
   * The jar.
   *
   * A store that is missing, misconfigured or unreachable must not stop an anonymous
   * extraction: fetching with no cookies is the first stage of this design and is
   * independently useful, so a broken store degrades to it rather than failing the
   * request. The settings screen is where that problem is reported; here it would only
   * turn a readable article into an error.
   */
  let cookie: string | null = null;
  try {
    const sessions = await openSessionContext();
    if (sessions !== null) cookie = cookieHeaderFor(target, await loadJar(sessions));
  } catch {
    cookie = null;
  }

  const result = await extract(target.toString(), { timeoutMs: TIMEOUT_MS, cookie });

  if (!result.ok) {
    /*
     * A failure, not an exception, and it carries its own short tag — "HTTP 403",
     * "Readability returned empty". 200 rather than 5xx because the request was
     * fine and the answer is real: this article cannot be extracted, which is
     * something the client caches and shows, not something it retries at once.
     */
    return json(
      { url: result.url, ok: false, tag: result.tag, authenticated: result.authenticated },
      200,
    );
  }

  const html = cleanExtracted(result.html, {
    title: result.title ?? undefined,
    excerpt: params.get('excerpt') ?? undefined,
  });

  /*
   * The verdict travels with the article.
   *
   * Whether the *extraction* is itself a stub is the client's business — it decides
   * whether to keep this or fall back — and it is also the expired-session signal:
   * extraction succeeded, output still trips the heuristic, and cookies were sent for
   * that host, means the session has almost certainly lapsed.
   *
   * Reported, never acted on. The spec is explicit that nothing auto-clears here, and
   * the reason is that this signal has a second cause it cannot distinguish: a page
   * whose body is assembled by client-side script looks exactly the same, and clearing
   * a perfectly good session over one such article would be a silent regression the
   * reader could only fix by pasting a header again.
   */
  const truncation = isTruncated(html);
  const sessionExpired = result.authenticated && truncation.truncated;

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
      sessionExpired,
    },
    200,
  );
}
