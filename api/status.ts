/**
 * Connection status for `/settings`: is this deployment actually wired to
 * Instapaper?
 *
 * The first function behind `requireSession`, and the proof that the guard works
 * end to end — Phase 2's "done when" is exactly this call round-tripping while an
 * unauthenticated one is refused.
 *
 * Unlike `/api/health`, which says only that the deployment is up, this one talks
 * to Instapaper and so must never be reachable without a session.
 */
import { ConfigError, requireEnv, requireSession } from '../src/lib/guard';
import { InstapaperError, credentialsFromEnv, verifyCredentials } from '../src/lib/instapaper';

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
    if (error instanceof ConfigError) {
      // Name the missing variable: the reader is the operator, who is already past
      // the gate and is the only person who can fix it.
      return json({ connected: false, reason: 'not_configured', detail: error.message }, 200);
    }
    throw error;
  }

  // Instapaper is a third party and this call sits in front of a settings screen;
  // a hung request should surface as "can't tell" rather than a spinner.
  const timeout = AbortSignal.timeout(10_000);

  try {
    const { username } = await verifyCredentials(credentials, timeout);
    return json({ connected: true, username }, 200);
  } catch (error) {
    if (error instanceof InstapaperError) {
      return json(
        {
          connected: false,
          reason: error.status === 401 ? 'rejected' : 'error',
          detail: error.message,
        },
        200,
      );
    }
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    return json(
      {
        connected: false,
        reason: timedOut ? 'timeout' : 'error',
        detail: timedOut ? 'Instapaper did not respond within 10s' : 'Could not reach Instapaper',
      },
      200,
    );
  }
}
