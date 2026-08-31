# Vercel configuration notes

Why `vercel.json` says what it says. The file itself can't carry comments — the schema
rejects unknown keys — so the reasoning lives here.

## `rewrites`

```json
{ "source": "/((?!api/).*)", "destination": "/index.html" }
```

The SPA fallback for client-side routes: `/read/123` has no file behind it, so the shell
has to answer and let the router take over.

The negative lookahead is the part worth keeping. Without it the fallback also swallows
`/api/*`, and a mistyped or not-yet-deployed function path returns the app shell with
`200 OK` instead of a 404 — which surfaces later as a fetch that "succeeded" and then
failed to parse HTML as JSON. Filesystem routes are matched before rewrites, so working
functions resolve either way; the lookahead is what makes the _broken_ ones fail honestly.

## `headers`

- **`/fonts/*` and `/assets/*` — one year, immutable.** Vite content-hashes everything in
  `assets/`. The fonts aren't hashed, but they're versioned by the deploy and only change
  when `npm run fonts` pulls a new upstream revision, so a long cache is safe and the
  service worker precaches them anyway.
- **No cache header on the shell.** `index.html` and the generated service worker must
  stay revalidated, or an install pins itself to a stale build.
- **`nosniff`, `strict-origin-when-cross-origin`, `DENY`.** Baseline. `x-frame-options`
  costs nothing here since nothing needs to embed Stash.

**No CSP yet, deliberately.** Phase 6 injects sanitized third-party article HTML, and a
policy written before we know what that markup needs is either too tight to render
articles or so loose it isn't a policy. It goes in with the reading view, informed by what
`get_text` and our own extraction actually return.

## Runtime

The functions run on Node, not Edge — Phase 7's extraction path uses `@mozilla/readability`
with `linkedom`, and the work plan chose Vercel specifically so that pairing works
directly rather than needing a Workers-compatible reimplementation.

## Local parity

`vercel dev` serves the static app and `api/` on one origin, the same as production, which
is what makes the CORS story honest: there is no cross-origin call to configure because
there is no second origin.

`npm run dev` runs Vite alone — faster, but functions 404. Use it for UI work, `vercel dev`
for anything touching `/api`.

## `Secure` cookies and `localhost` vs `127.0.0.1`

The session cookie is always `Secure`. Browsers make an exception that lets a `Secure`
cookie work over plain HTTP on a trustworthy origin — but that exception is keyed to the
hostname `localhost`, **not** to the literal IP `127.0.0.1`.

Verified in Chromium against the real handlers:

| Origin | Cookie stored | Cookie sent back | Guarded call |
| --- | --- | --- | --- |
| `http://localhost:PORT` | yes | yes | 200 |
| `http://127.0.0.1:PORT` | yes | **no** | 401 |

The failure is quiet and misleading: unlocking succeeds, the cookie is visibly in the jar,
and every subsequent request is refused. It looks like a broken session implementation.

`vercel dev` serves on `localhost`, so the normal workflow never hits this. It matters if
you point a test client, a script, or a second browser tab at `127.0.0.1` instead. Check
the address bar before the code.

## Environment variables

Set as Vercel environment variables, never in the client bundle. `.env.example` documents
all five. Phase 9's deploy step verifies none of them reached `dist/` by grepping the built
output for the token.
