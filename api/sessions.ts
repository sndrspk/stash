/**
 * Publisher sessions: the endpoint behind the settings screen.
 *
 *   GET                  -> { configured, hosts: [{ host, cookies: [names], updatedAt }] }
 *   POST { host, cookie } -> { host, cookies: [names], added }
 *   DELETE ?host=         -> 204, or 404 when nothing was stored
 *
 * The rule this file exists to enforce is the one in `docs/EXTRACTION.md`: **cookie
 * values are never returned to the client.** They go in; only names come out. That is
 * why GET is not "read the store and serialise it" — `listSessions` cannot return a
 * value, and the accessor that can (`loadJar`) is called by `api/extract` and by
 * nothing else.
 *
 * Every response is gated by the passphrase like every other function here. That is not
 * belt-and-braces: an ungated POST would let anyone attach their own cookies to this
 * deployment's outbound fetches.
 */
import { coerceHost } from '../src/lib/cookies.js';
import { requireSession } from '../src/lib/guard.js';
import { EncryptionKeyError } from '../src/lib/secrets.js';
import {
  deleteSession,
  listSessions,
  openSessionContext,
  saveSession,
  type SessionContext,
} from '../src/lib/site-sessions.js';

/** A pasted header is a few hundred characters. A megabyte of it is not a paste. */
export const MAX_HEADER_CHARS = 32_768;

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    // `no-store` on all of it. A host list is not secret, but it is a list of what
    // someone subscribes to, and it has no business in a shared cache.
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });

/**
 * Resolve the store, turning the two ways it can be unusable into two different
 * answers: "no store attached" is a fact the settings screen explains, and a missing
 * encryption key is a deployment mistake that must not read as one.
 */
async function withContext(run: (context: SessionContext) => Promise<Response>): Promise<Response> {
  let context: SessionContext | null;
  try {
    context = await openSessionContext();
  } catch (error) {
    if (error instanceof EncryptionKeyError) {
      return json({ error: 'not_configured', detail: error.message }, 503);
    }
    throw error;
  }

  if (context === null) {
    return json(
      {
        error: 'no_store',
        detail:
          'No key-value store is attached to this deployment, so publisher sessions cannot be saved. Extraction still runs without one.',
      },
      501,
    );
  }
  return run(context);
}

export async function GET(request: Request): Promise<Response> {
  const refusal = requireSession(request);
  if (refusal) return refusal;

  let context: SessionContext | null;
  try {
    context = await openSessionContext();
  } catch (error) {
    if (error instanceof EncryptionKeyError) {
      return json({ configured: false, hosts: [], cleared: [], detail: error.message }, 200);
    }
    throw error;
  }

  /*
   * A deployment with no store answers 200, not an error.
   *
   * The settings screen has something true and useful to say about it — sessions are
   * optional, extraction works without them — and it can only say it if this is a
   * normal response rather than a failure the UI renders as "could not load".
   */
  if (context === null) return json({ configured: false, hosts: [], cleared: [] }, 200);

  const listing = await listSessions(context);
  return json({ configured: true, ...listing }, 200);
}

export async function POST(request: Request): Promise<Response> {
  const refusal = requireSession(request);
  if (refusal) return refusal;

  let body: { host?: unknown; cookie?: unknown };
  try {
    body = (await request.json()) as { host?: unknown; cookie?: unknown };
  } catch {
    return json({ error: 'bad_request', detail: 'Expected a JSON body.' }, 400);
  }

  if (typeof body.host !== 'string' || typeof body.cookie !== 'string') {
    return json({ error: 'bad_request', detail: 'host and cookie are both required.' }, 400);
  }
  if (body.cookie.length > MAX_HEADER_CHARS) {
    return json(
      { error: 'bad_request', detail: 'That is far too long to be a Cookie header.' },
      413,
    );
  }

  // A mistyped host is stored under a key no request will ever match, which fails
  // silently — the worst outcome for a credential store, so it is refused here.
  const host = coerceHost(body.host);
  if (host === null) {
    return json(
      { error: 'bad_request', detail: `"${body.host.slice(0, 80)}" is not a hostname.` },
      400,
    );
  }

  return withContext(async (context) => {
    const saved = await saveSession(context, host, body.cookie as string);
    if (saved === null) {
      /*
       * Nothing usable was pasted. Deliberately not stored as an empty session and
       * deliberately not a wipe of what is already there: backing out of a paste must
       * never destroy a session captured earlier.
       */
      return json(
        {
          error: 'no_cookies',
          detail:
            'No name=value pairs in that. Copy the Cookie request header from the Network tab, not the Application → Cookies panel.',
        },
        400,
      );
    }
    return json(saved, 200);
  });
}

export async function DELETE(request: Request): Promise<Response> {
  const refusal = requireSession(request);
  if (refusal) return refusal;

  const raw = new URL(request.url).searchParams.get('host');
  const host = raw === null ? null : coerceHost(raw);
  if (host === null) return json({ error: 'bad_request', detail: 'host is required.' }, 400);

  return withContext(async (context) => {
    const existed = await deleteSession(context, host);
    return existed ? new Response(null, { status: 204 }) : json({ error: 'not_found' }, 404);
  });
}
