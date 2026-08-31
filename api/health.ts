/**
 * The Phase 1 stub function: proof that `vercel dev` serves the app and the
 * serverless layer together on one origin, and that the build wires them up.
 *
 * It is deliberately the only function that will ever be reachable without a
 * session. Everything added from Phase 2 onward goes behind `requireSession()`,
 * and this one stays trivial precisely so that exemption stays safe to grant:
 * it reports that the deployment is up, and nothing whatsoever about it — no
 * env var names, no versions, no Instapaper reachability.
 */
export function GET(): Response {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: {
      'content-type': 'application/json',
      // A health check has no cacheable value.
      'cache-control': 'no-store',
    },
  });
}
