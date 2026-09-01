# Vercel configuration notes

Why `vercel.json` says what it says. The file itself can't carry comments — the schema
rejects unknown keys — so the reasoning lives here.

## `rewrites`

```json
{ "source": "/((?!api/)(?!@)(?!.*\\.).*)", "destination": "/index.html" }
```

The SPA fallback for client-side routes: `/read/123` has no file behind it, so the shell
has to answer and let the router take over.

Three exclusions, each earning its place.

**`api/`** — without it the fallback also swallows `/api/*`, and a mistyped or
not-yet-deployed function path returns the app shell with `200 OK` instead of a 404, which
surfaces much later as a fetch that "succeeded" and then failed to parse HTML as JSON.

**`@` and anything containing a dot** — these exist because of `vercel dev`, and their
absence broke local development outright.

In production, rewrites are applied *after* the filesystem check, so real assets win and a
greedy pattern is mostly harmless. `vercel dev` is different: it applies rewrites **before**
proxying to the Vite dev server, whose module graph is served from memory and never touches
disk. A pattern of `/((?!api/).*)` therefore rewrote `/src/main.tsx` and `/@vite/client` to
`/index.html`, Vite was handed HTML where it expected a module, and the dev server failed
with `Failed to parse source for import analysis` pointing at `<title>Stash</title>` — an
error that says nothing whatsoever about routing.

The rule that satisfies both environments: **a client route has no file extension and does
not begin with `@`.** Every built asset (`/assets/index-abc.js`, `/sw.js`,
`/fonts/x.woff2`), every dev module (`/src/main.tsx`), and every Vite internal
(`/@vite/client`, `/@react-refresh`) has one or the other. Routes like `/settings` and
`/read/12345` have neither.

`test/api-health.test.ts` asserts all four groups, so a future edit that reintroduces
either failure mode fails in CI rather than the next time someone runs `vercel dev`.

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

## Relative imports in functions need `.js`

`package.json` declares `"type": "module"`, so the deployed functions run as real Node
ESM — where an extensionless relative import does not resolve. Every relative import
under `api/` and `src/lib/` therefore ends in `.js`, even though the file on disk is
`.ts`. That is the standard TypeScript-to-ESM convention, and TypeScript resolves it
correctly.

This is worth its own section because **nothing local catches it**. Vite resolves
extensionless imports for the client, Vitest resolves them for the test suite, and
`vercel dev` resolves them too. Only the built deployment fails, and it fails as:

```
500: INTERNAL_SERVER_ERROR
Code: FUNCTION_INVOCATION_FAILED
```

— which says nothing about imports. `/api/status` shipped this way once while
`/api/health`, which imports nothing at all, kept returning `{"ok":true}` and made the
deployment look healthy.

`test/module-resolution.test.ts` asserts the rule across both directories, so the failure
now surfaces in CI instead of in production.

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

Set as Vercel environment variables, never in the client bundle. Phase 9's deploy step
verifies none of them reached `dist/` by grepping the built output for the token.

**Five are required for a working deployment.** A sixth, `STASH_ENCRYPTION_KEY`, is
documented in `.env.example` and reserved for Phase 7b's publisher cookies; nothing reads it
yet, and leaving it unset changes nothing today.

| Variable | Missing means |
| --- | --- |
| `STASH_PASSPHRASE` | **Every API call is refused with 503 before it starts.** The gate will not compare against an unset value. |
| `INSTAPAPER_CONSUMER_KEY` | `/api/status` and Sync answer `not_configured`, naming the variable. |
| `INSTAPAPER_CONSUMER_SECRET` | as above |
| `INSTAPAPER_OAUTH_TOKEN` | as above |
| `INSTAPAPER_OAUTH_TOKEN_SECRET` | as above |

**Scope them to Production, not Preview.** Every branch gets a preview URL, and a preview
carrying live credentials is a second public door to the same Instapaper account. The
consequence is that Sync will not work on a preview deployment — which is correct, and worth
knowing before you spend time debugging it.

**Adding a variable does not change a deployment that already exists.** Vercel attaches the
environment at deploy time, so an existing deployment keeps the set it was built with.
Redeploy after adding one.

### The failure that cost an hour

A deployment had the four Instapaper variables and no `STASH_PASSPHRASE`. It produced two
messages that sounded unrelated and neither of which named the cause:

- `/settings` — "Not connected. Could not reach Instapaper."
- Sync — "Could not sync: `not_configured`"

Both came from the same 503 refusal by `requireSession`. `/settings` cast the refusal body
to a status object, which left every field undefined and rendered as an Instapaper
connectivity problem; Sync read that body's `error` field and reported the bare code. Nothing
Instapaper-related had run.

`/unlock` got it right the whole time — it says "This deployment has no passphrase set. Add
`STASH_PASSPHRASE` and redeploy." **When a deployment misbehaves in a way that smells like
credentials, check `/unlock` first**; it is the one screen whose only job is the gate. The
other two now distinguish a refusal from an Instapaper failure, but the ordering advice
stands.
