/**
 * The shared body of `api/archive` and `api/delete`.
 *
 * **One bookmark, one action, one explicit click.** There is deliberately no batch
 * endpoint anywhere in Stash: these calls reach into a real Instapaper account, and
 * delete is irreversible there. A batch endpoint is the thing that turns a UI bug
 * into a hundred lost articles instead of one, so the absence is enforced here
 * rather than merely intended — an array where a number belongs is a 400, not a
 * loop.
 */
import { ConfigError, requireEnv, requireSession } from './guard.js';
import { InstapaperError, call, credentialsFromEnv } from './instapaper.js';

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

/**
 * Accepts a single positive integer id, and nothing else.
 *
 * Returns null for anything else, including an array of ids — which is the shape a
 * caller would send if it assumed batching, and the one worth refusing loudly.
 */
export function parseBookmarkId(body: unknown): number | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const raw = (body as { bookmark_id?: unknown }).bookmark_id;
  const id = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number(raw) : NaN;
  return Number.isInteger(id) && id > 0 ? id : null;
}

export async function handleBookmarkAction(
  request: Request,
  action: 'archive' | 'delete',
): Promise<Response> {
  const refusal = requireSession(request);
  if (refusal) return refusal;

  let credentials;
  try {
    credentials = credentialsFromEnv(requireEnv);
  } catch (error) {
    if (error instanceof ConfigError) {
      return json({ error: 'not_configured', detail: error.message }, 503);
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = await request.json();
  } catch {
    return json({ error: 'bad_request' }, 400);
  }

  const id = parseBookmarkId(parsed);
  if (id === null) return json({ error: 'bad_request', detail: 'expected one bookmark_id' }, 400);

  try {
    await call(
      `/api/1.1/bookmarks/${action}`,
      [['bookmark_id', String(id)]],
      credentials,
      AbortSignal.timeout(15_000),
    );
    return json({ ok: true, bookmark_id: id }, 200);
  } catch (error) {
    if (error instanceof InstapaperError) {
      return json({ error: 'instapaper', status: error.status, detail: error.message }, 502);
    }
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    // The client rolls its optimistic update back on any non-2xx, so an ambiguous
    // timeout resolves toward showing the article again rather than hiding one that
    // may not have been archived.
    return json({ error: timedOut ? 'timeout' : 'unreachable' }, 504);
  }
}
