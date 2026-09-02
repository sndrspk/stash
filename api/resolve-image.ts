/**
 * One article's representative image.
 *
 * This is the function that fetches an arbitrary third-party URL from inside our own
 * infrastructure, which makes it the sharpest edge in the deployment. Everything
 * about the shape below follows from that:
 *
 * - The **session gate runs first**, so an anonymous request never causes an
 *   outbound fetch. A public URL fetcher is a useful thing to have stolen.
 * - The URL is validated with `assertFetchable` **before** `guardedFetch` is called,
 *   even though `guardedFetch` would validate it again. The duplication is the
 *   point: the refusal for `169.254.169.254` is then visibly a refusal, at a line
 *   you can read, rather than a consequence buried inside the fetch helper.
 * - Every redirect hop is re-validated by `guardedFetch`, because a permitted URL
 *   that bounces to the metadata endpoint is the whole SSRF trick.
 *
 * The answer is deliberately three-valued rather than two, and the HTTP status
 * carries the third: `ok` and `none` are 200 and permanent, a refusal is 403 and
 * also permanent, and anything else is a 502/504 the client may retry. Caching a
 * transient failure as "this page has no image" is the failure mode worth designing
 * against — it is silent, and it lasts.
 */
import { requireSession } from '../src/lib/guard.js';
import { throttle } from '../src/lib/rate-limit.js';
import {
  BlockedUrlError,
  MAX_REDIRECTS,
  assertFetchable,
  guardedFetch,
} from '../src/lib/fetch-guard.js';
import { pickImage } from '../src/lib/og-image.js';

/**
 * Smaller than the extractor's 5 MB cap, and shorter than its deadline.
 *
 * A declared image lives in `<head>`, so the answer almost always arrives in the
 * first few kilobytes; the rest is read only for the `<img>` fallback. Hundreds of
 * these run during one sync, and a slow site must cost a slot for seconds rather
 * than half a minute.
 */
export const MAX_PAGE_BYTES = 2 * 1024 * 1024;
export const TIMEOUT_MS = 12_000;

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

export async function GET(request: Request): Promise<Response> {
  const refusal = requireSession(request);
  if (refusal) return refusal;

  const limited = throttle(request, 'images');
  if (limited) return limited;

  const raw = new URL(request.url).searchParams.get('url');
  if (raw === null || raw.trim() === '') {
    return json({ error: 'bad_request', detail: 'url is required' }, 400);
  }

  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    // A bookmark whose URL will not parse is permanently unresolvable, and the
    // client caches this as such rather than asking again every sync.
    return json({ error: 'bad_request', detail: 'url is not a URL' }, 400);
  }

  try {
    await assertFetchable(target);
  } catch (error) {
    if (error instanceof BlockedUrlError) {
      return json({ error: 'blocked', detail: error.message }, 403);
    }
    throw error;
  }

  let response;
  try {
    response = await guardedFetch(target, {
      timeoutMs: TIMEOUT_MS,
      maxBytes: MAX_PAGE_BYTES,
      maxRedirects: MAX_REDIRECTS,
    });
  } catch (error) {
    if (error instanceof BlockedUrlError) {
      return error.permanent
        ? json({ error: 'blocked', detail: error.message }, 403)
        : json({ error: 'timeout' }, 504);
    }
    if (error instanceof Error && error.name === 'TimeoutError') {
      return json({ error: 'timeout' }, 504);
    }
    return json({ error: 'unreachable' }, 502);
  }

  if (response.status < 200 || response.status >= 300) {
    // Retryable, including 403 and 404: a paywall or a bot check today can be a
    // page tomorrow, and one dull front-page slot is a smaller cost than a
    // permanent blank recorded on a bad afternoon.
    return json({ error: 'http', status: response.status }, 502);
  }

  const { imageUrl, from } = pickImage(response.body, response.url);
  return json(
    {
      url: response.url,
      status: imageUrl === null ? 'none' : 'ok',
      image_url: imageUrl,
      from,
    },
    200,
  );
}
