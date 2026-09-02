/**
 * One article's text, as Instapaper has it.
 *
 * Phase 5 needs this for excerpts — the four front-page slots derive theirs from the
 * article when the bookmark carries no `description` — and Phase 6 reads it for the
 * reading view itself. It is the same call and the same cache row, so it is written
 * once, here, rather than twice.
 *
 * **The body is third-party HTML and is returned unsanitised.** That is deliberate,
 * and it is safe only because of where sanitising belongs: at the point of
 * injection, not at the point of transport. Phase 5 never injects it — it reduces it
 * to plain text for an excerpt, and tags cannot survive that. Phase 6, which does
 * inject it into the document, must run it through DOMPurify or equivalent first.
 * Sanitising here instead would be worse: the reading view would silently depend on
 * a cleaning step it could not see, and a cached row written before the rule changed
 * would be trusted forever.
 *
 * `get_text` answers with an HTML fragment rather than JSON, which is why this uses
 * `callText`; a 400 from it means "no text available for this bookmark" — a paywall,
 * a video page, a PDF — and is a fact about the article rather than a fault.
 */
import { ConfigError, requireEnv, requireSession } from '../src/lib/guard.js';
import { throttle } from '../src/lib/rate-limit.js';
import { InstapaperError, callText, credentialsFromEnv } from '../src/lib/instapaper.js';

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

export async function GET(request: Request): Promise<Response> {
  const refusal = requireSession(request);
  if (refusal) return refusal;

  const limited = throttle(request, 'text');
  if (limited) return limited;

  const raw = new URL(request.url).searchParams.get('bookmark_id');
  const bookmarkId = raw === null ? NaN : Number(raw);
  // Rejected rather than coerced: a request for bookmark NaN would be signed, sent,
  // and answered with something unhelpful at the other end.
  if (!Number.isInteger(bookmarkId) || bookmarkId <= 0) {
    return json({ error: 'bad_request', detail: 'bookmark_id must be a positive integer' }, 400);
  }

  let credentials;
  try {
    credentials = credentialsFromEnv(requireEnv);
  } catch (error) {
    if (error instanceof ConfigError) {
      return json({ error: 'not_configured', detail: error.message }, 503);
    }
    throw error;
  }

  let result;
  try {
    result = await callText(
      '/api/1.1/bookmarks/get_text',
      [['bookmark_id', String(bookmarkId)]],
      credentials,
      AbortSignal.timeout(20_000),
    );
  } catch (error) {
    if (error instanceof InstapaperError) {
      return json({ error: 'instapaper', status: error.status, detail: error.message }, 502);
    }
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    return json({ error: timedOut ? 'timeout' : 'unreachable' }, 504);
  }

  if (result.status === 400) {
    // A real, cacheable answer: Instapaper has no text for this one and will not
    // acquire any by being asked again. Phase 7's extraction fallback is what
    // eventually turns this into an article; until then it is an honest empty.
    return json({ bookmark_id: bookmarkId, html: null, reason: 'no_text' }, 200);
  }
  if (result.status < 200 || result.status >= 300) {
    return json({ error: 'instapaper', status: result.status }, 502);
  }
  if (result.body.trim() === '') {
    return json({ bookmark_id: bookmarkId, html: null, reason: 'empty' }, 200);
  }

  return json({ bookmark_id: bookmarkId, html: result.body }, 200);
}
