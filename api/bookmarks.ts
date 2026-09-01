/**
 * The unread bookmark list.
 *
 * A pure proxy: it signs the call, hands back what Instapaper said, and does no
 * filtering or reshaping of its own. Reconciliation happens on the client, against
 * the local cache, where the previous state actually lives.
 */
import { ConfigError, requireEnv, requireSession } from '../src/lib/guard.js';
import { InstapaperError, call, credentialsFromEnv } from '../src/lib/instapaper.js';
import { parseBookmarkList } from '../src/lib/sync.js';

/**
 * Instapaper's per-call maximum is 500. The plan's whole design assumes a personal
 * queue rather than an archive, and a first sync on a large account is already the
 * most expensive thing Stash does.
 */
const LIMIT = '500';

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

export async function GET(request: Request): Promise<Response> {
  const refusal = requireSession(request);
  if (refusal) return refusal;

  let credentials;
  try {
    credentials = credentialsFromEnv(requireEnv);
  } catch (error) {
    // Name the variable. This is behind the gate, the only reader is the operator,
    // and they are the only person who can fix it. Reporting the bare code cost a
    // round trip: `/api/status` named it and this one did not, so the two screens
    // disagreed about the same deployment and neither said which variable.
    if (error instanceof ConfigError) {
      return json({ error: 'not_configured', detail: error.message }, 503);
    }
    throw error;
  }

  try {
    const raw = await call(
      '/api/1.1/bookmarks/list',
      [
        ['folder_id', 'unread'],
        ['limit', LIMIT],
      ],
      credentials,
      AbortSignal.timeout(20_000),
    );
    return json({ bookmarks: parseBookmarkList(raw) }, 200);
  } catch (error) {
    if (error instanceof InstapaperError) {
      return json({ error: 'instapaper', status: error.status, detail: error.message }, 502);
    }
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    return json({ error: timedOut ? 'timeout' : 'unreachable' }, 504);
  }
}
