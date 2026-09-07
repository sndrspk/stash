# Stash — Work Plan

Implementation plan for porting the native macOS Article Reader to a PWA. The product spec is
[`docs/DESIGN_SPEC.md`](docs/DESIGN_SPEC.md); this file is the architecture, the build order, and
the risks worth knowing before starting.

Working notes for the agent doing the work:

- Phases are ordered by dependency. Each phase ends in something demonstrable — don't start the
  next one until the current one runs.
- Every phase has an explicit "done when" that can actually be checked.
- Anything marked **⚠ blocked** needs an answer before that phase starts. Do the unblocked work
  first; don't guess.

---

## Architecture (decided)

The design spec assumed Supabase. That has been dropped. Stash is **single-tenant**: one deployment
serves one person, and anyone else who wants it deploys their own from the public repo. Everything
below follows from that.

### No accounts, and almost no database

There is no Supabase, no Postgres, no RLS, and no login for Stash itself. A user table with one row
in it is not worth its own auth system. What Supabase was carrying in the spec, and what replaces
it:

| Spec (Supabase) | Stash |
| --- | --- |
| Supabase Auth identity | none — one instance, one person |
| `instapaper_credentials` table (RLS) | OAuth token/secret in deployment env vars |
| Edge Functions as CORS proxy | serverless functions in the same deployment |
| Bookmark/text/image cache tables | IndexedDB, per device |
| Cross-device cache sharing | dropped; each device syncs for itself |

One thing does need server-side persistence: the per-publisher session cookies the extraction
fallback replays (see [`docs/EXTRACTION.md`](docs/EXTRACTION.md)). They are bearer credentials, so
they must never reach the browser, and they change at runtime, so env vars can't hold them. That is
a key-value store — a hosted dictionary of host → cookie header, no tables or schema — rather than a
database, and it is worth one instead of dragging auth back in.
[`SESSIONS.md`](SESSIONS.md#where-they-live-once-stash-is-deployed) explains it in plain terms.

### Where each piece of data lives

| Data | Home | Why |
| --- | --- | --- |
| Instapaper OAuth token | deployment env var | set once, never changes at runtime |
| Instapaper consumer key/secret | deployment env var | same |
| `STASH_PASSPHRASE`, encryption key | deployment env var | same |
| Bookmark list | IndexedDB | pure cache — Instapaper is the source of truth |
| Article text (both sources) | IndexedDB | cache; re-fetchable, purged 7 days after archive/delete |
| Reading preferences | IndexedDB | per-device is fine |
| Resolved `og:image` URLs | IndexedDB, **plus** server KV | expensive to re-resolve; the one cache worth sharing |
| **Per-host site cookies** | **server KV, encrypted** | credentials: never client-side, must be updatable |

**None of the client-side data is precious.** Bookmarks live in Instapaper, article text is
re-fetchable, preferences are three numbers. This matters because browsers evict: iOS Safari clears
site data for origins unused for ~7 days unless the PWA is installed to the home screen. Call
`navigator.storage.persist()`, install the app, and accept that a wipe costs API round-trips rather
than data. The single exception is image resolution — genuinely expensive to redo across hundreds of
third-party sites — which is why it gets a server-side copy alongside the cookie store.

### The serverless layer stays

Not optional, for the reasons in spec §6: Instapaper's API and arbitrary third-party sites send no
CORS headers, so a browser cannot call them. It is also the only place the OAuth token exists. The
functions deploy alongside the static PWA — same origin, no separate service to run.

### Credentials: a one-time CLI exchange, then env vars

The spec's in-app "enter your Instapaper email and password" screen is **deliberately dropped**. For
a single-tenant instance there is a strictly better option:

1. `npm run connect` — a local script prompts for the Instapaper email and password, performs the
   xAuth exchange, prints the resulting OAuth token and secret, and exits. Nothing is stored.
2. The operator pastes those into the deployment's environment (`INSTAPAPER_OAUTH_TOKEN`,
   `INSTAPAPER_OAUTH_TOKEN_SECRET`, plus `INSTAPAPER_CONSUMER_KEY` / `_SECRET`).
3. The deployed app never sees a password, never has a credential-writing code path, and has no
   store to leak.

This honours the terms-of-use constraint more strictly than the original design did: the password
exists only in a local process the operator ran themselves.

### Access control

The deployment URL is public, and behind it sits an account that can be read and deleted from. A
single `STASH_PASSPHRASE` env var, exchanged once for a signed httpOnly session cookie, gates every
function. One screen, no user model. **Every function checks the cookie** — an unauthenticated
request must never reach Instapaper.

### Article text: two-tier extraction

Instapaper's `get_text` is tried first. When it returns nothing, a stub, or obvious paywall
boilerplate, Stash re-extracts from the source URL itself, using the method ported from SanFeedBin.
Specified in full in [`docs/EXTRACTION.md`](docs/EXTRACTION.md); the short version:

- Everything downstream of the fetch ports cleanly — the truncation heuristic, Readability, the four
  cleaners, store-beside-never-over, failure tags, retry backoff, single-flight.
- **The cookie capture does not port.** SanFeedBin reads the WebView's jar via Android's
  `CookieManager`; a browser cannot read another origin's cookies, and no API will ever let it.
  Replaced in stages: unauthenticated extraction first (which already handles soft paywalls), then
  manual per-host cookie paste in settings, then optionally a browser extension.
- Site cookies live encrypted in server KV, in a **separate store from the Instapaper token** —
  rotating one must never destroy the other.

### Hosting: Vercel

Recommended, and the plan assumes it:

- Node runtime on the functions, so the extraction path can use the mature `@mozilla/readability` +
  `linkedom` combination directly rather than a Workers-compatible reimplementation.
- Static PWA and functions in one project, one origin, no CORS config of our own.
- Env vars and `vercel dev` give local/production parity for the secret handling.
- Hobby tier is free and sufficient. Note it is non-commercial-use only — fine for this.

Alternatives, if you'd rather: **Cloudflare Pages + Workers** has a more generous free tier and no
cold starts, at the cost of reworking extraction for the Workers runtime; **Netlify Functions** is
near-identical to Vercel. Nothing outside Phase 1 and Phase 8 depends on the choice.

### Settled product questions

- **Excerpts** — use the bookmark list's `description` when present; otherwise fetch full text for
  the four front-page slot articles and derive the excerpt from it.
- **Unread** — means "in the Instapaper `unread` folder". `progress` is ignored entirely; articles
  leave the queue only by an explicit archive or delete.
- **Cache retention** — cached text and images are marked for purge on archive or delete, with a
  **7-day grace period**, so an undone action doesn't force a re-fetch. Purging happens as a sweep
  on app start; no scheduled job needed.

---

## Phase 0 — Prerequisites

- [x] Instapaper Full API consumer key/secret obtained. **They are secrets: they go in `.env`
      locally and in the host's env vars, never in this repo, an issue, or a PR.** Verify xAuth is
      enabled on the key with the first `connect` run — it is granted per-application and its
      absence only shows up at the token exchange.
- [x] SanFeedBin extraction method obtained and ported to a spec —
      [`docs/EXTRACTION.md`](docs/EXTRACTION.md).

**Done when:** the credentials are in hand and the extraction method is specified. Both are.

> **The fixture capture used to live here, and has moved to [Phase 2a](#phase-2a--fixture-capture).**
> It asked for *real* bookmark records and *real* `get_text` payloads, which take an authenticated
> Instapaper call, which takes the OAuth token, which `npm run connect` produces — a Phase 2
> deliverable. As written, Phase 0 could not be finished until Phase 2 was, while Phases 1 and 2
> were meant to be built behind it. Capturing it right after the token exists costs nothing and
> makes the ordering honest; nothing in Phase 1 or Phase 2 needs fixtures.
>
> `fixtures/` is not empty in the meantime. It holds two synthetic pages,
> `soft-paywall-stub.html` and `soft-paywall-full.html`, written as test doubles for
> `src/lib/truncation.ts`. They are source-site HTML for the extraction path, not `get_text`
> payloads, and they are invented rather than captured — useful for the unit tests they were
> written for, and not a substitute for the set below.

---

## Phase 1 — Project skeleton

- [x] Vite + React + TypeScript, ESLint + Prettier, `npm run typecheck`. `npm run check` runs the
      four gates together, which is exactly what CI runs.
- [x] Routing: `/` (front page), `/read/:bookmarkId`, `/settings`, `/unlock`, plus a 404. Each
      route renders a placeholder naming the phase that fills it. `/unlock` sits outside the shell
      — it is the one screen reachable without a session.
- [x] `vite-plugin-pwa`: manifest, icons, service worker registration, install prompt handling.
      `registerType: 'prompt'`, not `autoUpdate` — an article being read must never be swapped out
      from under the reader. Icons are generated by `scripts/icons.ts`, so the mark is reviewable
      in a diff rather than committed as opaque binaries.
- [x] Base theme layer: CSS custom properties, light/dark (following the OS, with an explicit
      `data-theme` override that wins), and the four reading fonts (Source Serif 4, Crimson Pro,
      Piazzolla, Geist) **self-hosted** — latin subset, variable weight 400–700, refreshed by
      `npm run fonts`. The reading-column presets (22/34/56em) live here as tokens so Phase 6 has
      one home for `--reading-column-width`.
- [x] Vercel project config (`vercel.json`, reasoning in [`docs/VERCEL.md`](docs/VERCEL.md)) and a
      stub `api/health` function.
- [x] CI: GitHub Actions running lint, format, typecheck, tests and build on push and PR.

**Done when:** `npm run build` produces an installable PWA that loads an empty shell, `vercel dev`
serves it with a stub function responding, and CI is green.

**Done.** All five routes render in light and dark in a real browser, with the self-hosted font
loading and no console or request errors; the full CI sequence passes from a clean `npm ci`; and
`vercel dev` was run on macOS against Node 20.20.2, with `curl localhost:3000/api/health` returning
`{"ok":true}`. That last one confirms the app and the serverless layer really do come up together
on one origin, which is the whole reason the plan chose a host that serves both.

Two things that first run turned up, both fixed:

- **`engines` was looser than reality.** It said `>=20`, while Vite and ESLint need `^20.19.0`.
  Someone on Node 20.5 would have installed cleanly and then hit failures with no obvious cause.
  It now names the true floor.
- **`vercel dev` wants a `build` script before it will start**, even though it never runs one —
  it validates the build settings while linking the project. Not a problem now that Phase 1 has
  landed, but it is why the very first attempt failed against a pre-Phase-1 checkout, and worth
  knowing before blaming `vercel.json`.

`vercel dev` remains the right tool for anything touching `/api`: `npm run dev` serves the app
alone and 404s every function.

---

## Phase 2 — Credentials and the gate

- [x] `scripts/connect.ts` (`npm run connect`): prompts for email + password, performs the xAuth
      exchange against `/api/1/oauth/access_token` with HMAC-SHA1 signing, prints the token/secret
      as ready-to-paste env lines, stores nothing, logs no password. Refuses to run
      non-interactively, so a password can never arrive down a pipe and into a log.
- [x] `src/lib/oauth.ts`: OAuth 1.0a request signing, shared by the script and the functions,
      **tested against the RFC 5849 worked example**. See the note below on what that did and did
      not turn out to establish.
- [x] `/unlock` screen + `api/unlock`: constant-time comparison against `STASH_PASSPHRASE`, then a
      signed httpOnly `Secure` `SameSite=Lax` cookie. Attempts are rate-limited, and the limit is
      applied *before* the comparison, so exhausting it refuses even a correct passphrase.
- [x] Shared `requireSession()` guard. It returns a refusal `Response` rather than throwing, so the
      call site reads `if (refusal) return refusal;` and skipping it is visible in review. A
      misconfigured deployment answers 503, never 401 — an unset passphrase must never be compared
      against and must never look like a rejected credential.
- [x] `.env.example` documents every variable; `.env` is git-ignored. (There are **six**, not the
      five this line used to claim: consumer key and secret, token and token secret, passphrase,
      encryption key.)
- [x] `/settings` shows connection status via `api/status` — the first function behind the guard —
      and explains that reconnecting means re-running the script. When a variable is missing it
      names which one; the only reader is the operator, who is already past the gate.

**Done when:** the script yields a working token, an authenticated function call round-trips to
Instapaper, and an unauthenticated request to any function is refused.

**Status: done.** The gate is verified and the token exchange has been run against Instapaper —
`npm run connect` returned a token pair, which settles the one question that was outside our
control: xAuth *is* enabled on the consumer key. Every capture since has authenticated with it.

Driven in a real browser against the real handlers: an unauthenticated `/api/status` is refused
401; a wrong passphrase is refused with no cookie set; the right one issues an httpOnly `SameSite=Lax`
cookie and the same call then returns 200; signing out returns it to 401. 158 unit tests cover the
pieces underneath.

Two findings worth keeping:

- **The RFC 5849 example does not give a usable end-to-end signature.** §3.1 prints a request
  carrying `oauth_signature="bYT5CMsGcbgUdFHObYMEfcx6bsw%3D"` but never states the secrets behind
  it, and §3.4.2's signing key belongs to a different discussion; pairing them is a guess, and the
  guess fails. What the RFC *does* give, and what `test/oauth.test.ts` asserts, is the normalized
  parameter string and the signature base string — which is where OAuth 1.0a implementations
  actually go wrong. The HMAC step is pinned separately against RFC 2202. Both halves right means
  the composition is right, and that is what licenses `connect`'s 401 message pointing at xAuth
  rather than at our signing.
- **`Secure` cookies and `127.0.0.1`.** The trustworthy-origin exception that lets a `Secure`
  cookie work over plain HTTP applies to the hostname `localhost`, not to the literal IP. On
  `http://127.0.0.1` Chromium accepts the cookie and then declines to send it back, so unlocking
  appears to succeed and every later call 401s. `vercel dev` uses `localhost`, so this is a trap
  rather than a defect — but it costs an hour if you meet it without knowing.

- **The first real `connect` run returned 400, and that was our bug.** The `x_auth_*` credentials
  were being signed and placed in the `Authorization` header with an empty body; they are
  form-encoded *body* parameters, and the header carries only `oauth_*`. Instapaper never saw them,
  so it rejected the request as malformed rather than as unauthorised.

  Two things are worth taking from it. **400 and 401 mean different things and the distinction is
  the diagnostic**: 400 is a malformed request, 401 is one that was understood and refused — only
  the second is about credentials or permissions. And **every unit test passed while this was
  broken**, because the signing helpers were correct and the request assembled out of them was not.
  The fix removed the header/body escape hatch that made the mistake possible, moved request
  construction into `src/lib/xauth.ts` where the wire format can be asserted, and pinned it: what is
  in the body, what is in the header, and that the password is in neither the header nor anything
  that logs one. Confirmed against a local echo server, not just in unit tests.

Nothing is left open here.

---

## Phase 2a — Fixture capture

Moved out of Phase 0: this is the first point in the plan where a live authenticated call is
possible. Phase 3 was built ahead of it at the operator's request; nothing was lost, but Phases 5 and
6 genuinely want real payloads.

- [x] `scripts/capture.ts` (`npm run capture`): pulls the unread list, fetches `get_text` for a
      sample (default 20, `--limit` to widen, 700ms apart), measures each article, and writes
      `fixtures/bookmarks.json`.
- [x] Picks one article per shape into `fixtures/text/` — soft paywall, hard paywall, image-heavy,
      wide embeds, very long, short — by **measuring** rather than guessing, reusing the Phase 7a
      truncation heuristic to identify the stub. The two paywall shapes are claimed first: they are
      identified by a property nothing else can substitute for, so assigning them last would let a
      stub be spent as the "short" example and leave the case uncovered. A shape with no candidate
      is reported as missing rather than padded.
- [x] **Scrub before committing** — reframed, because the original bullet understated it. Stripping
      account-identifying fields is not enough. Two things are being published: a record of what
      someone reads, and publishers' article prose. So the fixtures keep **structure** and discard
      **content**: every tag, attribute, nesting depth, paragraph count, image dimension and
      character count survives exactly, and every word is replaced with filler of the same shape.
      That is not a compromise for what these are for — Phase 5 picks slots by image presence and
      headline length, Phase 6 computes a column count from rendered height, and neither cares what
      the words say. Untouched originals go to `fixtures/.raw/` under `--keep-raw`, git-ignored.
- [x] `fixtures/MANIFEST.md` is generated with the run, recording each file's shape, its
      measurements, and why that shape is in the set.

**Done when:** `fixtures/` holds the bookmark records and the six text shapes, scrubbed and
documented, and the truncation tests run against the real stub payload rather than only the
synthetic one.

**Status: done.** The capture has been run against the real account and the fixtures are committed:
`bookmarks.json` (20 records) and five articles under `fixtures/text/`. `soft-paywall` found no
candidate — nothing in the folder was a truncated stub — and the shape is covered by the standing
pair described above rather than by a captured file.

The written output was audited rather than assumed: every URL across the set resolves to
`example.com`, all 9,445 letter-runs of prose are filler, and the bookmark records carry only the
six fields Stash reads.

One finding for Phase 4: **Instapaper's `get_text` strips `srcset` entirely.** There is not one in
any fixture, and `<source>` elements arrive with no attributes at all. Responsive sources are
therefore unavailable from cached text — Phase 4 has `img src` and whatever Phase 7's extraction
fetches directly, and nothing else.

Three bugs the anonymiser had, all found by running it against real markup rather than test strings,
and all silent:

- **Full documents came back empty.** `get_text` returns a fragment, and linkedom parses a fragment
  as a sibling of `<body>`; the fix used a container element, which then discarded `<html>`,
  `<head>` and `<body>` when given a whole page. A captured page anonymised to `<!DOCTYPE html>` and
  nothing else, with no error.
- **Relative URLs leaked the publisher.** Only `https?://` values were rewritten, so every
  `href="/environment/the-real-slug"` kept its section and headline slug.
- **Fixing that broke file extensions.** Relative paths went through the plain text anonymiser, so
  `hero-1400.jpg` became `elit-1400.sed` — and Phase 4 branches on what an image URL looks like.

Class names are deliberately **kept**: they are CSS hooks, and Phase 7's furniture-removal rules
select on them, so anonymising them would make the fixtures useless for the phase most likely to
need them.

**Regenerating** (done once already; the fixtures are committed):

```sh
npm run capture -- --dry-run   # see what would be captured, write nothing
npm run capture                # write the anonymised fixtures
```

Read `fixtures/MANIFEST.md` and skim the output before committing a fresh set. The rule stands even
though the output is anonymised: never commit a fixture you have not read. Four bugs in the
anonymiser were found by looking at its real output and none by re-reading its code, so the check
that matters is the one that does not assume the anonymiser is correct.

---

## Phase 3 — Data layer and sync

- [x] IndexedDB schema (via `idb`), in [`src/lib/db.ts`](src/lib/db.ts). Two departures from the
      sketch above, both deliberate:
      - **`state` gained a fourth value, `gone`.** It is ours, not Instapaper's: the bookmark
        vanished from the remote list without us archiving or deleting it — moved to another
        folder, or removed from another client. See the reconcile rule below.
      - **`article_text` is keyed `${bookmark_id}:${source}`, not by `bookmark_id`.** Phase 7's
        store-beside-never-over requires both sources to coexist, which a single key per bookmark
        cannot express. Keying by bookmark would have quietly made the extracted copy overwrite the
        Instapaper one — the exact thing that rule exists to prevent.
- [x] `api/bookmarks`: proxies the bookmark list for the `unread` folder. A pure proxy — it does no
      filtering of its own, because reconciliation needs the previous state and that lives on the
      client.
- [x] Client sync: upsert into IndexedDB, reconcile removals. **A bookmark absent from the remote
      list is marked `gone`, never deleted**, because dropping rows on absence makes the cache only
      as trustworthy as the last response. A truncated page or a transient empty list would destroy
      state that took API calls to build. Marking is reversible; the next sync that mentions the row
      restores it.
- [x] `api/archive` and `api/delete`: one bookmark, one action. The absence of a batch endpoint is
      **enforced**, not merely intended — an array where a number belongs is a 400, not a loop.
      Delete is irreversible at Instapaper, so that distinction is worth a test rather than a
      comment.
- [x] Optimistic archive/delete with exact rollback; sets `purge_after = now + 7 days` on the cached
      text and image rows. The local mark returns a snapshot of every row it touched, which is what
      makes the rollback exact rather than approximate.
- [x] Purge sweep on app start, in `runStartupPurge`. Deletes only rows whose `purge_after` is set
      and in the past; a null mark is not in the index at all, so it is never even considered.
      Reappearing in a sync clears the mark, which is what makes an undone archive keep its text.
- [x] TanStack Query over the IndexedDB layer. Queries read from **IndexedDB, never the network**;
      syncing is a separate mutation that fetches, writes, then invalidates. So there is one source
      of truth, it works offline, and a failed sync leaves the last good data on screen.

**Done when:** the bookmark list round-trips, archiving in Stash is visible in Instapaper's own web
UI, and the purge sweep drops exactly the rows past their grace period and no others.

**Status: done.** The purge rule and the round trip were verified in a browser; the last open
item — that archiving in Stash is visible in Instapaper's own account — has now been confirmed
against the real account on the deployed app. Sync pulls the unread list and archive round-trips.

Driven in a real browser against the built client, with a stubbed Instapaper: unlock, sync, three
articles newest-first, **reload and the list comes back from IndexedDB with no network call**,
archive removes a row, and a forced 502 on the next archive restores the list exactly. 237 unit
tests cover the rest, with the store tests running against a real IndexedDB implementation rather
than a stand-in that would agree with our assumptions.

The purge clause is asserted directly: three articles, one archived long ago, one archived just now,
one never archived — exactly one row is collected, and the boundary is tested at the deadline as
well as past it.

**Confirmed live.** Sync against the real account returns the unread list, and archiving in Stash
removes the article from the account. Everything up to the API call was already verified; that it
is the *right* API call is what this run establishes.

Two things stood between the code being right and this being demonstrable, and both are worth
keeping because neither was visible from the code.

**`bookmarks/list` answers with an object, not an array.** `parseBookmarkList` assumed an array —
a bug that shipped **in this phase**, passed every unit test, and passed a browser run against a
stub written to the same assumption. Both layers agreed with each other and neither had met the
API. Fixed in Phase 2a.

**The deployment had no `STASH_PASSPHRASE`.** Every call was refused with 503 before a line of
Instapaper code ran, and two screens described that one cause in two unrelated ways — `/settings`
blamed Instapaper connectivity, Sync reported a bare `not_configured` — because a refusal body was
being cast to a status object. `/unlock` had the correct message the whole time. Deployment
environment requirements are now documented in [`docs/VERCEL.md`](docs/VERCEL.md), which is where
this should have been findable.

A plain list stands in for the front page meanwhile, labelled as a Phase 3 scaffold. Phase 5
replaces it wholesale — it exists so the data layer is demonstrable, not as a half-built version of
the newspaper layout.

---

## Phase 4 — Image resolution

- [x] `api/resolve-image`: given a bookmark's source URL, fetch the page, parse `og:image`, fall
      back to the first `<img>`, return the result (including "none") for the client to cache. The
      picking is [`src/lib/og-image.ts`](src/lib/og-image.ts), kept pure and network-free because
      *which* image a page yields is the part with judgement in it — so it is tested against a
      string rather than a site.
- [x] **SSRF guard — required, not optional.** Every rule is enforced, and `assertFetchable` is
      called by the endpoint **before** `guardedFetch` even though `guardedFetch` validates again.
      The duplication is the point: the refusal for `169.254.169.254` is then a line you can read,
      not a consequence buried in a helper. The guard itself was already written and tested in
      Phase 2a; this phase gave `BlockedUrlError` a `permanent` flag, so a timeout is not cached as
      "this URL can never work".
- [x] Bounded concurrency (3 in flight) with a per-host delay (1s), in
      [`src/lib/image-queue.ts`](src/lib/image-queue.ts). The scheduler is **host-aware rather than
      a plain pool**: concurrency alone is no protection, because a reader who saves twenty articles
      from one newspaper would send all twenty to that newspaper as fast as three slots allow. When
      the next item's host is cooling down it looks past it rather than holding a slot, so one busy
      publisher does not stall the nineteen behind it.
- [x] Never re-fetch a URL that already has a cache row, positive or negative — with one deliberate
      refinement, below.

**Done when:** a full sync resolves images once, a second sync resolves zero, and a URL pointing at
`169.254.169.254` or `localhost` is rejected before any fetch happens.

**Status: done.** Driven in Chromium against the built client with a stubbed deployment: unlock,
sync, seven articles across three hosts, **seven resolve-image requests and seven distinct URLs**,
five thumbnails rendered and two articles correctly left without one. Reload and sync again:
**zero requests**, thumbnails still there from IndexedDB. Evict one cache row by hand and sync:
exactly one request. 398 unit tests cover the rest.

The rejection clause is asserted literally rather than by inspection: the metadata endpoint,
`localhost`, loopback, a private address, IPv6 loopback, a `file:` URL and `instapaper.com` each
return 403 **with the network stubbed and asserted never to have been called** — rejected before any
fetch, not after one that was then discarded. A redirect from a permitted host to
`169.254.169.254` is refused on the hop, with exactly one fetch attempted.

Three things are worth naming because they are departures, not details.

**An `error` row is retried after a week, not on the next sync.** "Never re-fetch, positive or
negative" is the right rule for `ok` and `none`; applied to `error` it would mean a site that was
down once is never asked again. Retrying it every sync is the opposite failure — a standing tax paid
by whoever's server was unlucky that afternoon. So `needsImageLookup` holds a failure for the week
`docs/EXTRACTION.md` already settled on for retrying a failed URL. `none` stays permanent, exactly
as before.

**The HTTP status carries the third value.** `ok` and `none` are 200 and permanent; a refusal is 403
and also permanent; everything else — a publisher 403, a 404, a timeout, an unreachable host — is a
502 or 504 the client may retry. The failure worth designing against is a transient error cached as
"this page has no image": it is silent, and it lasts. A 401 is neither, and aborts the pass rather
than writing two hundred error rows because a cookie lapsed.

**Overlapping passes queue rather than skip.** SanFeedBin's single-flight rule is the wrong shape
here: the second trigger is usually a *different* list, because a sync finishing mid-pass brings new
bookmarks, and dropping them would leave their pictures unresolved until the app was next opened.
Serialising costs nothing instead — the queued pass reads the rows the previous one just wrote and
skips every URL they had in common, which is the same protection single-flight was offering.

**Not done here: the server-side copy of the image cache.** The architecture table gives resolved
`og:image` URLs a KV copy alongside the IndexedDB one, as the single cache expensive enough to be
worth sharing between devices. There is no KV store yet — it arrives in Phase 7b with the session
store — and standing one up for this alone would mean a second implementation to migrate. The cache
is per-device until then, which costs a re-resolution on a new device and nothing else.

The Phase 3 scaffold now shows a thumbnail per row, for the same reason it exists at all: seeing a
resolved image next to an article is what makes the pass demonstrable. The slot rules that decide
*which four* articles get a picture are Phase 5's.

---

## Phase 5 — Front page

- [x] Layout: hero (image + title + excerpt), three secondary cards with images, sidebar with
      5-oldest and 5-newest unread title-only lists.
- [x] Slot selection: hero and three secondaries picked at random from unread bookmarks that have a
      resolved image, in [`src/lib/front-page.ts`](src/lib/front-page.ts) — pure and seeded, so the
      rules are tested against arrays rather than against a rendered page. Image-less bookmarks are
      excluded from those four slots only.
- [x] Excerpts: `description` when present, else derived from fetched text for the four slot
      articles. Only those four ever fetch; everything else on the page is title-only and would be
      paying for prose it never shows.
- [x] Responsive: one column below 60rem, the three cards stacking below 42rem, hero still the hero
      and the sidebar lists below the stories rather than in a drawer. A drawer would hide the two
      lists that exist precisely to be glanced at.
- [x] Empty, loading (skeletons) and error states. Zero unread says so and offers the one useful
      action; skeletons hold the page's shape so nothing jumps when the content lands.
- [x] Pull-to-refresh and an explicit refresh action, both triggering a sync.

**Done when:** the front page renders from fixtures and from live data, reshuffles on refresh, and
never shows an image-less article in an image slot.

**Status: done.** Driven in Chromium against the built client with a stubbed deployment — eighteen
articles, a third of them without a picture, half of them without a `description`, so both the
exclusion rule and both excerpt paths have something to bite on. Twenty-one checks, all passing:
hero and three cards all illustrated, no image-less article in any slot, five and five in the
sidebar with no repeat of a slot article and no overlap between the lists, an excerpt on every slot
article, and text fetched for exactly the slot articles that had no description. Six refreshes
produced four distinct heroes and **no further image lookups** — reshuffling is free.

On a 390×844 phone: no horizontal overflow, the hero still at the top, the cards in one column, the
sidebar below the stories. A synthesised touch drag arms the indicator past the threshold and a
release triggers exactly one sync. 455 unit tests cover the rest, including the slot rules asserted
across 200 seeds rather than the one that happened to work.

Four things are worth naming.

**The sidebar excludes what is already on show, and the two lists never overlap.** Neither is in the
spec. A front page that runs its lead story again halfway down the sidebar has spent one of its ten
remaining rows saying nothing; and with fewer than fourteen unread, "5 newest" and "5 oldest" name
some of the same articles, which reads as a bug rather than as a fact about the queue. `newest` is
filled first and `oldest` takes what remains, so nothing is printed twice.

**`api/text` landed here rather than in Phase 6.** Phase 5's excerpts need `get_text` and Phase 6
needs the same call and the same cache row, so it is written once. **The body is returned
unsanitised, deliberately**: sanitising belongs at the point of injection, not of transport. Phase 5
never injects it — it reduces it to plain text, which no tag survives. **Phase 6 must run it through
DOMPurify or equivalent before putting it in the document**, and its bullet still says so.

**Archive and delete moved to the reading view**, which is where the spec puts them, and where the
Phase 3 scaffold's list was not. They sit on the Phase 6 placeholder for now — plainly, with no
reading view around them — rather than leaving the app with no way to archive anything until Phase 6
lands.

**Not every unread article is reachable from the front page.** Four slots and ten sidebar rows show
fourteen; a queue of fifty leaves thirty-six on no screen at all. That is what a front page *is*,
and the spec describes no other view — but it means a large queue has no browsable index. Raised as
an open question rather than answered here, since inventing an "all unread" screen is a product
decision, not a Phase 5 detail.

---

## Phase 6 — Reading view

The highest-risk phase. Section 4 of the spec is the specification; it encodes bug fixes that cost
real iteration in the native app, and reverting to naive CSS multi-column will reintroduce them.

- [x] `api/text`: `get_text` via the API, cached client-side — landed in Phase 5, which needed it
      for excerpts. **Sanitize the returned HTML** before injecting it: done here, in
      [`src/lib/sanitize.ts`](src/lib/sanitize.ts), which is the only place anything is ever
      injected. An allowlist rather than a denylist, and it **fails closed** — without a DOM to
      parse into, DOMPurify reports itself unsupported and returns its input *unchanged*, which at
      a trust boundary is the worst possible default because it looks like it worked.
- [x] Multi-column horizontal pagination with the **deterministic column count** algorithm:
      measure natural height at `columnCount: 1`, compute
      `columnCount = ceil(naturalHeight / availableColumnHeight)`, then set an explicit width of
      `columnCount * (columnWidth + gap) - gap + horizontalPadding`. Do not let the browser
      auto-fit — that is what causes end-of-article text to bleed past the padding. The arithmetic
      is pure, in [`src/lib/columns.ts`](src/lib/columns.ts); the measurement is
      [`useColumnLayout`](src/hooks/useColumnLayout.ts). **The formula turned out to be a lower
      bound, not an answer** — see below.
- [x] Re-measure on every image `load` event, on resize, and on any typography preference change.
- [x] Snap-to-column after scroll settles (140ms debounce), from the *rendered* box rather than the
      CSS preference; the first column snaps back to `scrollLeft: 0` and the last snaps to the true
      end.
- [x] Typography preferences: font family, size, line height, column width (Narrow 22em / Medium
      34em / Wide 56em, default Medium), **and a reading mode** — see the departure below.
      Persisted in IndexedDB — a new `settings` store, at
      `DB_VERSION` 2 with a stepwise upgrade, since a browser cache can be on any version the app
      has ever shipped. Normalised field by field on read, so a preset renamed in a later release
      degrades to the default rather than leaving an unreadable column with no way back.
- [x] `--reading-column-width` clamp on `img`, `video`, `iframe`, `table`, `pre` in the body.
- [x] `orphans: 2; widows: 2;` on paragraphs and list items.
- [x] Touch: a horizontal drag is the browser's own scroll, with the snap catching where it lands;
      tap zones on the left and right thirds, behind the article so a link is still a link.
      Keyboard: arrows, page up/down, space and shift-space, escape to close.
- [x] Per-article archive and delete, plus close-to-home.
- [x] **Verification test:** on a long article, assert `scrollWidth ===` the content box's computed
      width exactly. That 0px check is the regression test for the whole approach.

**Mobile caveat to design around:** `100vh` and dynamic viewport height on iOS Safari change as the
address bar collapses, which changes `availableColumnHeight` and therefore the column count
mid-read. Use `100dvh`, and debounce re-measures so a scroll-triggered chrome collapse doesn't
reflow the article under the reader's finger. Budget real time for this — it is the most likely
source of "works on desktop, broken on my phone".

**Done when:** a long, image-heavy article paginates correctly on desktop and on a real phone, the
0px check passes, and preferences apply live without losing the reader's position.

**Status: done — at phone size in Chromium, and since on real hardware.** The reading view has now
been used on an Android phone, a MacBook and a tablet in Safari, which closes the "on a real phone"
half of the done-when and retires the mobile-Safari pagination risk below as a thing to worry about
rather than a thing to watch. The measurement run behind it: driven in Chromium against the built client, using
the committed fixtures as the articles — which is what makes "a long, image-heavy article" a claim
about something rather than about lorem ipsum. **46 checks, all passing.** The 0px check is asserted
at nine points: the long article, that article scrolled to its end, each of the three column-width
presets, after a face change, the image-heavy article with all 62 images loaded, the wide-embeds
article, the short one, and the whole thing again at 390×844. Every one reports a difference of
exactly 0px, on both `article.scrollWidth === article.clientWidth` and
`viewport.scrollWidth === article.offsetWidth`.

Also checked: the article never scrolls vertically; nothing — image, table or `pre` — is wider than
a column; a mid-column scroll is corrected to a boundary; the first column returns to exactly 0 and
the last to the true end; arrows, space and the tap zones each turn exactly one whole column; a
preference change keeps the reader within 2% of where they were; and the settings survive leaving
the article and coming back. The trust boundary is checked end to end against an article carrying
script tags, an `onerror`, a `javascript:` href, an iframe and inline styles: nothing executed,
nothing survived, and the prose between the attacks is intact. 508 unit tests cover the rest.

Four things this phase learnt that the spec could not have told us.

**The deterministic formula is a lower bound, not an answer.** It divides the article's natural
height by the height of a column, and that is right as far as it goes — but the single-column
measurement sees text flowing continuously, and the columnar layout does not. A figure or a heading
that must not be split is pushed whole into the next column, leaving the bottom of the previous one
empty. On the image-heavy fixture that unused space came to **nineteen extra columns**, and the
article bled a long way past a box sized for the height it measured. So the computed count is
applied and then *checked*, and raised by however many columns the overflow implies, until nothing
bleeds. It stays deterministic and it is bounded; it converges in two passes on the worst fixture.

**Measuring in place makes the measurement its own trigger, twice over.** The reflow to one column
changes the article's width. That (a) makes every `<picture>` and `srcset` image re-select a source
and fire `load` again, and (b) changes the scroller's content box, waking a `ResizeObserver` watching
it. Either one re-measures, which reflows, which fires again. The article re-measured about fifteen
times a second, forever. **The visible symptom was not a flicker**: it was that page turns did not
work — each measurement restored the scroll position and cancelled the smooth scroll mid-flight, so
a turn moved two pixels and stopped. Fixed three ways, all of which are worth keeping: each image
counts once, the viewport is watched through `visualViewport` rather than through an element we
ourselves perturb, and a measurement that lands on the layout already applied publishes nothing.

**"Measure the rendered stride from the DOM" cannot be done by sampling text.** The obvious reading —
find where lines begin and take the distance between column starts — does not survive contact with
real markup: `Range.getClientRects()` returns one rect per inline *fragment*, not per line, so a
paragraph containing links or emphasis contributes rects at arbitrary offsets. On the long fixture
that gave 102 distinct "column starts" for a 24-column article. The stride now comes from the
rendered box — its `clientWidth`, its padding, and the `column-count` it is actually laying out with
— which is still a measurement of the DOM and never the reader's preference, the thing the spec
actually warns against trusting. The warning was about a layout the browser fits for itself; this
one it does not.

**Both ends of the article are special, not just the first.** The spec says the first column returns
to `scrollLeft: 0` so the intro padding survives. The mirror case is easy to miss and looks
identical to the original bug: rounding to the nearest boundary near the end lands a little short,
which puts the viewport's right edge *inside* the final column and cuts the closing lines mid-word,
with the trailing whitespace the explicit width exists to produce sitting just off screen. Anything
within half a stride of the end now goes to the end.

### What a real phone found

The paragraph that used to sit here said the 390×844 run was Chromium emulating a phone and that an
actual iPhone was still worth half an hour. It was, and it found four bugs — every one of them
invisible to the checks that were passing.

**A column was wider than the screen.** The presets are absolute: Medium is 34em, which at 18px is
612px, on a 390px phone. Nothing clamped it, so the reader saw **59% of a column** and every line ran
off the right edge. The layout was correct by every measurement being taken — the 0px check passed,
nothing bled — and completely unreadable. *Geometry being self-consistent is not the same as it
being legible*, and no amount of the former proves the latter.

**The article had no horizontal padding at all on a phone**, because the rule setting it used
`var(--space-5)`, which is not on the scale. One undefined token voids the whole shorthand, silently.

**There was no headline anywhere.** `get_text` returns the article body and nothing else, so the
reading view opened straight into the first paragraph — or, worse, into the lead photograph with no
indication of what the article was. The bookmark's own title now leads the first column.

**The bar had four controls, no room, and no safe-area insets**, which put Delete under the notch.

The check that would have caught the first one is now in the run — *a whole column fits on the
screen* — along with checks for the bar, the padding and the headline. Two smaller things fell out
of the fixes: on a phone the column gutter is set equal to the two side paddings, which is what makes
a page turn exactly one screen rather than one screen plus a gutter; and the position restore moved
to immediately after the temporary single-column reflow, because that reflow makes the browser clamp
`scrollLeft` to 0 and a measurement that concluded "nothing changed" was returning early and leaving
the reader at the top of the article.

### Departure: a reading mode, defaulting by device

Spec §4 is emphatic that the article body is *not* a single vertically-scrolling column, and the
porting notes anticipated mobile explicitly — keep the paged model, change the input to touch-swipe.
That still stands, and once the column is clamped a phone gets exactly one column per screen, which
is the Kindle and Apple Books model and reads well.

But the strongest argument for scrolling on a phone was never width. It is that iOS Safari's address
bar collapses mid-read, changing the height a column has to fill: a paged layout has to fight that
and a scrolling one is simply immune. So rather than choose for the reader, the reading view now
offers both — `Paged` and `Scrolling`, in the same panel as the typography — which is what every
serious e-reader does.

The stored preference is **three**-valued: `auto`, `paged`, `scrolling`, defaulting to `auto`. That
is deliberate rather than incidental. A reader who has never opened the panel should get the right
mode for whatever they are holding and keep getting it when they rotate the device; a reader who has
chosen should get their choice everywhere. `auto` resolves to scrolling only on a **touch device
under 800px** — a narrow desktop window stays paged, because dragging a window edge is not the same
as picking up a phone.

Scrolling mode is mostly the column machinery switched off: the typography, the media clamp, the
widow and orphan rules, the headline and the sanitising are all shared. The one wrinkle worth
knowing is that `useColumnLayout` writes its geometry as *inline* styles, which outlive it — so
`.articleScrolling` overrides them with `!important`, which is the correct tool here rather than a
shortcut, because an inline style beats any selector and no amount of specificity takes an element
back from one.

**Still not verified: iOS Safari itself.** The mode switch is exactly the mitigation for the
address-bar problem, and it is chosen by default on phones — but "scrolling avoids the problem" is
still reasoning rather than observation.

### A fifth phone bug: the settings panel was anchored to the wrong edge

Found on Android, once the reading view itself was good enough to use. The panel was positioned
against the **"Aa" button** rather than against the bar, so its right edge landed wherever that
button happened to be — and on a phone the button sits mid-bar with Archive and Delete to its right.
A 22rem panel anchored there ran **110–138px off the left of the screen**: the typeface names were
cut to single letters, "Narrow" was gone entirely, and both sliders began off-screen.

It is not a phone problem and it did not get a phone fix. Anchoring to the button overflows at any
width where the button is not near the right edge — it only *showed* on a phone because that is
where the bar is crowded. The panel is now anchored to `.bar`, whose right edge is the screen's, and
`.settingsWrap` is explicitly `position: static` so it cannot become the containing block again by
accident. It also has a `max-height` and scrolls, because the panel is about 480px of controls and a
phone turned sideways is shorter than that.

Two things came with it. A tap anywhere else now dismisses the panel — on a phone it covers most of
the screen, so requiring a second tap on the button underneath it was asking the reader to aim at a
40px target they cannot see. And the browser run gained the check that would have caught this:
**every control in the panel is on screen**, not merely the panel's own box, at both phone and
desktop sizes.

That is the third bug in this phase whose common shape is worth naming: *a measurement that is
self-consistent tells you nothing about whether the result is usable.* The 0px check passed on an
unreadable article; the panel's own box was well-formed while half its contents were off-screen.
Every check added since asks whether a person could use the thing, not whether the numbers agree.

### Departure: a paper colour, and it is app-wide

Five sheets — beige (the default, and what the app always was), white, pastel blue, lilac and a
muted mustard — picked from the same panel as the typography, as swatches rather than names so the
control shows the thing it selects.

**It applies to the whole app, not to the reading view.** A front page on beige behind an article on
white would read as a bug rather than as a choice; there is one sheet of paper here, not two. So it
is set as `data-paper` on `<html>` from a component above the router, and every screen including the
gate is printed on it. It also rewrites the light `theme-color` meta, which on Android is the
visible half of the change — Chrome tints its own toolbar with it, and without that the browser
keeps a beige bar above a white page.

Only the surfaces move: `--ink` and the accent stay exactly where they are, which is what keeps all
five readable without five separate contrast arguments. Each paper is a pale tint, so the same
near-black text sits better than 15:1 on every one.

**Dark mode overrides the paper rather than tinting it**, and that is decided by declaration order
rather than by specificity, since the selectors are equal — so the paper blocks must stay above the
dark ones in `theme.css`, and a test asserts it. A pale blue sheet under a dark theme's light ink
would be unreadable, and a reader who asked for dark asked for dark. The choice is kept rather than
cleared, so it returns with a light theme.

The swatch in the panel and the palette in the stylesheet are two halves of one decision, which is
exactly the kind of pair that drifts silently — a swatch that no longer matches the paper it selects
is a control that lies, and it would look fine in a screenshot of either half alone. A test reads
`theme.css` and asserts every swatch equals the `--paper` it selects.

Where this *should* live long-term is arguably the Settings screen, which spec §5 reserves for app
theme as distinct from inline reading preferences. It is in the reading panel because that is where
you can see what it does, and because that is where it was asked for. Worth revisiting in Phase 9 if
Settings grows an appearance section.

---

## Phase 7 — Extraction fallback

Full detail in [`docs/EXTRACTION.md`](docs/EXTRACTION.md). Build it in that document's own staged
order — each stage is independently useful, which is what made it tractable on Android.

**Built ahead of the phases it belongs to**, because it answers the riskiest product question — is
the manual cookie paste worth doing? — before anything depends on the answer. `npm run probe`
fetches an article anonymously and authenticated and reports the difference. See
[`SESSIONS.md`](SESSIONS.md).

### 7a — Unauthenticated extraction

- [x] `src/lib/truncation.ts`: the heuristic, pure and side-effect-free — under 1500 characters, or
      a short sentinel list ("read more", "continue reading"), `[…]` only when it ends the text.
- [x] `src/lib/fetch-guard.ts`: the SSRF guard, with every redirect hop re-validated. Shared with
      Phase 4's image resolver — same arbitrary-URL exposure, same rules.
- [x] `src/lib/extract.ts`: credential-free fetch (honest `Stash/0.1 (+repo)` User-Agent, redirects
      followed manually, 25s deadline) → `@mozilla/readability` → HTML fragment. One result type
      out; non-2xx, empty body and empty Readability output are ordinary failures with a stable tag
      capped at 80 chars.
- [x] `scripts/probe.ts`: the CLI, including `--file` for reducing a saved page with no network.
- [x] **Verified against a live site.** nieuwsblad.be, 2026-08-31: anonymous `HTTP 403`, with a
      pasted session `HTTP 200`, 636 KB fetched, 7,024 characters extracted, title and byline
      correct. The premise holds — replaying a reader's own session turns a refusal into an article.
      Two things that run showed up:
      - The extracted text opens with a promotional interstitial ("Hoe is het voetbal … veranderd in
        uw gemeente?"), not the article's lede. Readability kept a furniture block. This is the
        duplicate-title / missing-intro / furniture work below, no longer hypothetical.
      - The stored session includes `cf_clearance` and `__cf_bm`. Cloudflare binds `cf_clearance` to
        the User-Agent and IP that earned it, and we send neither — so it works today but is the
        first thing to suspect when that host starts failing, and it will expire far sooner than a
        login cookie. Expectations in `SESSIONS.md` should say so.
- [x] The four cleaners as separate pure functions over the fragment (`linkedom`): duplicate title,
      missing intro, page furniture, hero image. Furniture removal runs **at render time**, so a new
      rule fixes already-cached articles without a re-sync.
- [x] Store beside, never over: `article_text` keeps both sources, a derived accessor picks
      `extracted ?? instapaper`, and the reading view gets a "show original" toggle for free. The
      accessor is not literally `extracted ?? instapaper`, and the difference is the whole of it: a
      *failed* extraction is recorded as an empty row, so the naive version answers a perfectly good
      article with a blank screen — precisely for the articles where extraction was needed and did
      not work. `bestOf` ignores an empty extracted row, and is the one place the question is asked.
- [x] Gating: run only when `get_text` output trips the heuristic. Retry backoff (one week) **in
      code, not in the query**. Single-flight try-lock around the pass. An explicit "fetch full
      content" action bypasses every gate. The try-lock is taken **before** the gates rather than
      after them: every gate is an `await` on IndexedDB, and a lock acquired past one is not a lock —
      two calls a millisecond apart both read, both find nothing in flight, and both fetch. The test
      for it deadlocked on the first attempt, which is how the ordering was found.

**Done when:** a soft-paywalled article that Instapaper returned a stub for renders in full, and a
hard-paywalled one fails with a legible tag rather than an exception.

**Status: done.** The stub → full path runs end to end in the browser against the committed
fixtures, and every failure shape — a refusal, a non-2xx, an empty Readability result — comes back
as a short tag the reading view prints beside the article rather than as an exception.

The browser run earned its place again, and this time by catching something the unit tests could
not: **every fixture was rendering the same extracted text.** The reading view asked
`needsExtraction` on its first render, before the article-text query had resolved; the honest answer
to "is `undefined` a stub?" is yes, and the gate in `extractArticle` then agreed with it, because
the IndexedDB row that gate re-reads is written by that very query. Two correct answers composing
into a publisher fetch for every article opened. The fix is at the call site — the offer and the
automatic pass both wait for the text to land — and the test pins the primitive's behaviour rather
than changing it, since "not loaded yet" and "is a stub" are different questions and only the caller
can tell them apart.

### 7b — Manual site sessions

- [x] `src/lib/cookies.ts`: RFC 6265 matching — `U == H` or `U` ends with `.H` — plus header
      parsing, last-wins merge, and a names-only accessor for anything user-facing. Tested
      adversarially before it had a caller: spoofed suffixes, substring hosts, leading dots, case,
      values containing `=`, IP literals, single-label hosts. That suite caught a real bug on first
      run (a saved `168.1.1` dot-suffix-matching the host `192.168.1.1`), which is the argument for
      writing it first.
- [x] Cookies are dropped on a cross-host redirect rather than forwarded — a session must never
      follow a bounce to a third party.
- [x] KV binding + `lib/secrets.ts`: AES-GCM under `STASH_ENCRYPTION_KEY`, corrupt-blob recovery
      deletes and recreates rather than crashing. **Separate namespace from anything Instapaper** —
      `stash:site-session:v1:` — and the Instapaper token is not in the store at all, so rotating one
      cannot destroy the other. `lib/kv.ts` is dependency-free: Vercel KV and Upstash both speak
      Redis-over-HTTP, so the client is thirty lines of `fetch` rather than a package. Recovery is
      *reported*, not silent: a blob that will not decrypt is deleted and the host is listed under
      `cleared`, because a session that vanished after a key rotation otherwise looks like a bug in
      the extractor. (The probe still reads a git-ignored `sessions.txt` — same shape, no encryption.)
- [x] `scripts/session.ts`: add/list/remove from the CLI, reading the header from stdin so it stays
      out of shell history. The dry run for Phase 7b's settings screen, and it enforces the same
      rule: values go in, only names come out.
- [x] `api/sessions`: POST a host + `Cookie:` header value, DELETE one host, GET the host list.
      Only `name=value` pairs are stored; everything else is dropped. **The cookie values are never
      returned to the client** — GET lists hosts and cookie names, and the accessor that can return a
      value (`loadJar`) is called by `api/extract` and by nothing else. The tests assert it on the
      serialised bytes rather than on the object, and on what reaches the KV provider as well.
- [x] Settings UI: add a session (host + paste), per-host sign-out, list of signed-in hosts, and a
      line explaining where to get the value (devtools → Network → copy the `Cookie` request
      header). Note plainly that this is a desktop-only step that benefits every device. Each host
      also shows how long ago its session was pasted, which is the first thing worth knowing when a
      publisher starts serving stubs again — a `cf_clearance` lasts hours and a login cookie months.
      A deployment with no store attached renders as a normal state saying so, not as a failure.
- [x] Attach the jar to the extractor. With an empty store this changes nothing at the wire level —
      the safe one-line change SanFeedBin's build order relies on, and there is a test asserting
      exactly that, because the day it stops being true is the day stage one stopped being what was
      shipped. A store that is missing, misconfigured or unreachable degrades to the anonymous fetch
      rather than failing the request.
- [x] The expired-session diagnostic: extraction succeeded, output still trips the heuristic, and
      cookies were sent for that host → surface "session may have expired" with a re-paste action.
      **Do not auto-clear** — one bad extraction is not proof a session is dead. Only the server knows
      whether cookies actually went out, so the server decides and the reading view only phrases it.
      The note is rendered above the article rather than inside the empty state: a stub Instapaper
      *did* return text for renders as an article, which is precisely the case the diagnostic is for.

**Done when:** pasting a session for a publisher you subscribe to turns one of its stub articles
into a full one, and clearing that session returns it to a stub.

**Status: built and exercised end to end against a stand-in deployment; not yet verified against a
live subscription.** The stand-in runs the real `api/sessions` and the real encryption over a
Map-backed Redis, so what the browser run checks is the deployed path, not a mock of it: pasting a
header stores exactly one namespaced key, that key holds ciphertext with no cookie name or value in
it, the screen lists names and an age and never a value, a wrong paste is diagnosed and kept rather
than swallowed, and signing out removes the blob. The half that needs a real publisher — that a
pasted session turns *that* publisher's stub into a full article — is the same claim `npm run probe`
already verified by hand on nieuwsblad.be in 7a, now going through the store instead of
`sessions.txt`. It wants one confirmation on the deployment.

**Update — sessions are stored on a real deployment.** A Redis Cloud store is attached and
several publishers' sessions are in it, which closes the store half against real
infrastructure rather than a Map. Getting there needed two changes recorded below: a TCP
transport, because Redis Cloud offers no HTTP endpoint, and a diagnostic that names the
variables it looked for. What is still unconfirmed is the narrow claim this "done when"
actually makes — that a pasted session turns *that publisher's* stub into a full article on
the deployment. First use went to a different question entirely, an article whose opening
paragraph was missing, which is recorded below and was not about sessions at all.

Two things the browser run changed, both invisible to a unit test:

- **Six controls do not fit a phone bar.** A stub article carries Close, Original, Aa, Full text,
  Archive and Delete; at 390px, Delete left the screen. Phase 6 bought room by dropping the crumb,
  and that room is spent. The bar now wraps, which is the answer that stays correct the next time a
  control is added — squeezing them would not have, and hiding one would have hidden the retry on
  exactly the article a reader has just pasted a session for.
- **The retry has to outlive the first attempt.** "Full text" was offered only while no extraction
  existed, so a stub extraction cached itself into a dead end: the note says the session may have
  expired, the reader goes and pastes a fresh one, comes back — and there is no button. It is now
  keyed on what is *on screen* rather than on what is in the cache.

### 7c — Browser extension (optional, deferred)

One-click cookie capture, the real equivalent of the Android WebView flow. Separate deliverable,
own store review. Build only if the paste step is what stops you using Stash.

---

## Phase 8 — Offline and PWA polish

- [x] Service worker: precache the app shell; runtime-cache article images. Registration is the
      other half of Phase 1's `registerType: 'prompt'`, which without a caller for
      `updateServiceWorker` installs a new build, waits, and never activates — an app permanently
      one version behind with nothing saying so. The prompt is a dismissible line at the foot of the
      screen, not a modal: nothing about a new build of a reading app is urgent, and it must not
      cover the article. Images are `CacheFirst` and matched on `request.destination` rather than on
      a host list, because the articles come from anywhere; `cacheableResponse: [0, 200]` is what
      keeps opaque cross-origin responses — which is most article images — from being discarded.
- [x] Offline reads work from the IndexedDB cache with no network.
- [x] Offline archive/delete: queue the intent, replay on reconnect, show clearly that the action is
      pending. (Still one explicit click per item — queuing is not batching, and the flush is
      sequential for the same reason there is no batch endpoint.) DB v3 adds `pending_actions`,
      keyed by `bookmark_id` so one article holds exactly one intent: archiving and then deleting
      the same article offline is a reader changing their mind, and replaying both would send
      Instapaper an archive for something they wanted gone.
- [x] Manifest, icons, splash screens, `theme-color`, iOS install metadata. Done in Phase 1 and
      verified here rather than rebuilt.
- [x] Lighthouse pass — **run, with one half still owed to the real deployment.** Two findings the
      wording of this item did not anticipate.

      **There is no PWA category any more.** Lighthouse 13 offers performance, accessibility,
      best-practices, SEO and agentic-browsing; the PWA category was removed from the tool. So the
      installability half of this checkbox was never going to be answered by Lighthouse, whatever it
      ran against, and is answered instead by the device run recorded under Phase 8 and by the
      manifest and service-worker checks in a browser's application panel.

      **Accessibility, best practices and SEO do not depend on the deployment**, so they were run
      here against the production build, served with `vercel.json`'s own headers and its rewrite
      rule, at 390×844 mobile emulation. Front page and reading view both: **accessibility 100,
      best practices 100, SEO 100**, after the contrast fix below. Accessibility was 92 before it.

      **Performance still is owed to the deployment**, and honestly so. Lighthouse's simulated Slow
      4G over localhost is a model, not a measurement: there is no CDN, no TLS handshake and no real
      latency in it. What it reports — 76 on the front page, 79 on the reading view — is worth
      recording as a shape rather than a score, and the shape is unambiguous. Every remaining audit
      below 1.0 that is not a timing metric says the same thing: unused JavaScript, unused CSS,
      render-blocking requests, network dependency tree. One 411 kB chunk with no code splitting,
      which is the same structural fact the chunk-size warning named. Splitting the routes is the
      fix, and it is a change to make deliberately rather than to chase a number on a stand-in.

**Done when:** the app installs on iOS and Android, opens offline, and shows a previously-read
article with no network.

**Status: offline verified end to end in Chromium; run on real devices 2026-09-07.** The browser
run does the whole journey with `setOffline(true)` — cold start with no network, a previously-read
article rendering from the cache, two archives queued, the intents surviving a reload, and the queue
draining by itself when the network returns. What it could not tell you is how the app behaves on
hardware, which is the half of the "done when" that wanted a phone: it has since been exercised on
an Android phone, on a MacBook in the browser, and on a tablet in Safari, and runs smoothly on all
three. What that does *not* yet cover is the install-to-home-screen step on iOS specifically, and a
cold offline start on the devices rather than in the harness — the two claims the "done when"
actually makes.

Two things the run found, both invisible to a unit test and one of them a real bug in the design:

- **The retry budget was being spent on being offline.** `MAX_ATTEMPTS` exists to stop an action
  that fails consistently for a reason the code cannot classify. Counting *every* failure against
  it meant a flush — which fires on app start, on `online`, and on each queued action — burned five
  attempts inside a single offline session. A reader archiving a handful of articles on a train
  would have watched them reappear, reverted for exceeding a budget while there was no network to
  answer. Failures are now three kinds rather than two: `unreachable` (no response at all — keep the
  intent, record why, **do not count it**), `retry` (the server answered and might answer
  differently), and `permanent`. Silence is not evidence about an action. The comment in the first
  version of the test asserted the opposite, confidently, which is the part worth remembering.
- **Offline, an un-downloaded article blamed the publisher.** It rendered "Instapaper has no text
  for this one — a paywall, a video page, or a PDF" and offered a fetch that could not work: a
  confident diagnosis of the wrong thing about an article that may be perfectly ordinary and one
  connection away. It also arrives as `isError` rather than as empty text, because the query throws
  with no network — so the first fix landed in a branch the case never reaches.

---

## Phase 9 — Settings, hardening, ship

- [x] Settings: connection status, appearance/theme, cache size, clear cache. Appearance is a
      pointer rather than a panel — the controls live behind **Aa** in the reading view, because
      every one of them reflows the article as you move it and two screens away they would be tuned
      blind. What "clear" *leaves* is the decision worth reading: pending actions, preferences and
      bookmark rows all survive, because someone freeing space is not asking to un-archive articles
      or reset their typeface. The byte figure is labelled origin-wide rather than presented as the
      cache's, since it includes the service worker's precache — which clearing does not remove, and
      presenting it otherwise would make the button look broken.
- [x] Error surfaces: an expired or revoked Instapaper token prompts to re-run `connect`, rather
      than failing silently. Sync already said so; the silent paths were the ones nobody watches —
      the eager text pass, which would have marked the whole front page as having no text and never
      mentioned why, and the offline queue, which counted it as an ordinary retry and would have
      silently un-archived every queued article after five app starts. `isTokenRejected` reads the
      one thing that distinguishes it: our own 502 wrapping Instapaper's 401.
- [x] Per-session rate limiting on the functions. Keyed by a hash of the session rather than by IP —
      the reverse of the unlock endpoint's choice, because a phone changes address walking down a
      street. `BUDGETS` puts every number in one place so they can be read side by side. These are
      not security limits (the gate is): they exist so a bug here cannot become a flood at somebody
      else's expense. The note about a durable KV-backed limiter was resolved rather than carried:
      the store is optional, so it would be absent on exactly the deployments configured least, and
      it would put a network round trip in front of every call to defend a single-user app.
- [x] Deploy: env vars set as Vercel secrets, none of them exposed to the client bundle. Verified by
      `npm run verify:build`, which greps the built output for each secret's *value* and also
      refuses any `VITE_`-prefixed secret in source — the second check needs no values and catches
      the mistake where it is made. It says loudly when the value search was skipped for want of a
      `.env`, because "nothing found" and "nothing looked for" must not read the same.
- [x] README deploy guide good enough that someone else can fork, run `connect`, deploy and use it.
- [x] Final terms-of-use review against the constraint list in the README. Five Instapaper endpoints
      are called in total and there is no `bookmarks/add`. One constraint needed rewording rather
      than defending: "an explicit, per-item user click" was written before the offline queue
      existed, and now says why a queue that replays clicks is still that.

**Status: done. The Lighthouse caveat is now half-answered and half-retired.** The accessibility,
best-practices and SEO categories do not depend on the deployment and were run here — all three at
100, after a contrast fix the audit prompted and hand-checking found to be worse than reported. The
PWA category the item asked for no longer exists in the tool. What is still owed to a real
deployment is the performance number alone, and what it would measure is already named: one
unsplit chunk. Both are written up under Phase 8's checkbox and in the section on the audit above.

**The browser run found a bug Phase 8 shipped**, and it is the sharpest example yet of a suite
agreeing with itself. TanStack Query's default `networkMode: 'online'` **pauses** a mutation while
the browser reports offline: `mutationFn` is never called and the promise never settles. So
archiving on a train did nothing at all — the button stayed disabled, no error appeared, and the
whole Phase 8 queue sat behind a pause that stopped it from ever being written to.

Phase 8's suite passed because of how it was written, not because the feature worked: it always
*navigated* after going offline, and a document loaded while already offline never receives an
`offline` event, so the query client still believed it was online. Going offline while sitting on a
page — which is what a reader actually does — is what fires the event. Both mutations and queries
are now `networkMode: 'always'`, which is not a workaround but an accurate description of what they
depend on: IndexedDB.

### The User-Agent was not the reason, and the probe said so in one command

The section below was written from the code and from how bot protection is known to
work, and it named the User-Agent as the reason most extractions returned 403. Setting
`STASH_USER_AGENT` to a browser string on the deployment did not clear them: still 403 on
some publishers, 405 on others, session sent.

Running the probe against a real publisher from a laptop took one command and settled it:

```
anonymous   HTTP 200  raw 13 KB  extracted 1,069 chars  looks truncated
            4 redirect(s) → https://sso.roularta.be/login
            Inloggen. Vul hier je e-mailadres en wachtwoord in om aan te melden…
```

**200, not 403 — with the same browser User-Agent and no session at all.** So the
User-Agent is not what those publishers object to, and the theory below was wrong. What
knack.be actually does to an unauthenticated request is send it through four redirects to
a single-sign-on host, which serves a perfectly ordinary sign-in page.

Two things follow, and only the first is fixed here.

**A 200 from another domain was being extracted as the article.** Readability reduced the
sign-in page to a tidy paragraph reading "Inloggen", and but for the truncation heuristic
catching it at 1,069 characters it would have been stored and rendered as the article
text. A longer login page would have sailed through. `reachedSameSite` now ends the fetch
when the final host is unrelated to the requested one — `www.knack.be` → `knack.be` is
fine, `www.knack.be` → `sso.roularta.be` is not — reusing the cookie jar's own RFC 6265
matching so the two cannot drift apart. A visible failure beats a cached article that is
quietly wrong and reads like the publisher's own text.

**Why the deployment says 403 where a laptop says 200 is still open.** The same URL, the
same User-Agent, and a different answer. The remaining difference is where the request
comes from: a serverless function in a datacentre against a residential connection, and
datacentre address ranges are routinely refused by the same protection that lets a home
address through. That is a hypothesis, and this time it stays labelled as one — the last
one was stated with more confidence than the evidence carried and cost a deploy, a
posture decision and two rounds to disprove. If it is right, no header changes it, and
`docs/EXTRACTION.md`'s ceiling is where this stops.

### The honest User-Agent is what this section originally blamed

First use against real paywalled publishers returned **HTTP 403 on most of them**. Not a
paywall stub, not an expired session — a refusal, before any cookie was read. Bot
protection rejects on User-Agent shape, and `Stash/0.1 (+repo)` is not browser-shaped, so
a reader with a valid paid session was turned away for how the request introduced itself
rather than for who was making it.

The probe has said this all along, in the hint it prints on a refusal: "some publishers
refuse anything that isn't a browser." It was written before there was a deployment to
find out on.

`STASH_USER_AGENT` overrides the default, per deployment, unset in the repository. The
posture note in `docs/EXTRACTION.md` is widened to say what changed rather than quietly
losing its edge, and the line it draws stays where it was:

- **Googlebot stays out.** Publishers serve crawlers text they deliberately withhold from
  readers, so a crawler UA takes something never on offer. That is circumvention whatever
  the intent.
- **A browser string is a different act** — one person's request, their own credentials, an
  article they pay for — *and* it defeats a control the publisher chose to deploy. Both are
  true, and the second does not stop being true because the first is.

Opt-in because the deployment is one reader's and the choice is about their own
subscriptions. As a default it would decide the question for everyone who forks this,
including people who never considered it, which changes what the project is rather than
what one deployment does.

Two things worth carrying:

- **A 403 was two problems wearing one status code.** With a session replayed it means the
  publisher refused us before the cookies mattered; without one it means no session reached
  that host, and the thing to check is the session list and the name it is filed under.
  `api/extract` had always returned `authenticated` on the failure path and the client
  dropped it, so the screen said "HTTP 403" and left a reader to guess — and the likelier
  guess sends them to re-paste a session that is working perfectly.
- **This could not be verified from here.** The development container's network policy
  blocks outbound requests to publishers, so the diagnosis rests on the code, the probe's
  own documented hint, and how bot protection is known to work — not on a measurement. It
  is the most likely cause by some distance and it is still a hypothesis until a real
  deployment with the variable set either stops 403-ing or does not.

### A merged change and a running build are different claims

Twice in one afternoon a change was merged and appeared to do nothing. Once because the
fix genuinely did not cover the case; once because the app was still running the previous
build — `registerType: 'prompt'` installs a new one and waits to be accepted, which is the
right behaviour for a reading app and indistinguishable, from the screen, from a change
that did not work.

The build number now sits beside the wordmark: `Stash v31`, numbered by the pull request
that shipped it. Not semver, because the question it answers is not "what release is this"
but "did the thing I merged reach me", and the number a reader already has in hand is the
PR they merged.

It sits beside the wordmark rather than inside its link — a version string is a label, not
a destination — and in the shell's masthead rather than on the front page, so it is present
on every screen except the reading view, which is deliberately bare. The gate carries its
own copy, since that is the one screen reachable before the app has loaded anything.

Two things to be honest about:

- **It is a habit, not a mechanism.** A production build runs from `main` after the merge
  and cannot know which PR it came from. `VERCEL_GIT_COMMIT_SHA` is available and truthful
  but answers a different question: it identifies a commit, not a change someone reviewed
  and merged. The number is bumped by hand, and a forgotten bump is worse than no number,
  because it would report a fix as live when it is not. `test/version.test.ts` checks the
  shape and that it never moves backwards; the rest is written down in `CLAUDE.md`.
- **The first attempt went in the wrong place.** Asked for it beside the "Stash" heading, a
  grep for `>Stash<` found only the unlock screen, and the badge went next to the front
  page's "Unread" instead — the masthead's own wordmark lives in `AppLayout` with the text
  on its own line, where that pattern does not match. Searching for the string as it would
  appear in rendered output rather than in source is a way to be confidently wrong about a
  file that is right there.

### Two questions the interface could not answer

Confirming that a publisher session does anything turned out to be impossible from the
app, and finding that out took asking a reader to do it.

**"Extracted by Stash" was not the claim anyone needed.** Plenty of soft paywalls yield to
an anonymous fetch, so an extraction that succeeded says nothing about whether the session
someone pasted did the work — and that is precisely the question they have when deciding
whether pasting one was worth two minutes at a desktop. The server has always known:
`api/extract` returns `authenticated`, and the expired-session diagnostic already used it.
It was simply never carried to the success path. It is now stored beside the extracted
text, because the question gets asked days later, comparing our copy against the
publisher's page, not in the second after the fetch. Absent stays absent: a row written
before the field existed says "Extracted by Stash" and nothing more, since claiming
"anonymously" about a fetch we cannot speak for would be a confident lie built on a
missing value.

**And there was no second fetch to be had.** "Clearing that session returns it to a stub"
is half of Phase 7b's own "done when", and it needs the article fetched again after signing
out. The only control that fetches is gated on `needsExtraction`, which is false for
anything already reading as complete — so after a successful extraction the button was
gone, and with it any way to perform the test. The same gap is why an improved extractor
never reached anything already cached.

One control now carries three meanings and is always offered: **Full text** when what is on
screen is a stub, **Re-extract** when an extraction is stored, **Extract** when neither.
Both of the first two shipped before the third, and shipping them without it did not fix
the problem — the first reader to look still saw "Text from Instapaper" on every article and
no button anywhere, because none of his articles was a stub and none had an extraction. An
article Instapaper returns complete could not be fetched at all.

That was the same mistake twice in one change: reasoning about which states deserve a
control instead of enumerating the states that exist. There are three, not two, and the
third is the common one.

All three pass `force`, which is the whole distinction from the automatic pass — a press is
a decision, so it skips the heuristic, the backoff and the already-extracted gate. The
machinery was always willing; only the button's visibility said no.

Two things worth carrying:

- **A checkbox can describe work that cannot be done.** "Confirm a pasted session turns a
  stub into a full article" sat in the plan reading like a two-minute job, through several
  reviews, while the interface offered no way to do it. It survived because it was written
  from the design rather than from an attempt. The reader who tried it found the gap in one
  message — and then found the *second* gap, in the fix for the first, in one more.
- **The identifier a reader reaches for is the one the screen shows.** Asked to find an
  article needing this test, the obvious move was to look for "Text from Instapaper" — which
  is the normal state of almost every article, and says nothing about whether anything is
  wrong. Extraction also runs automatically on a stub, so the button that was supposed to
  mark the case is usually gone before anyone sees it. A state worth acting on has to be
  named on screen, not inferred from the absence of something else.

### The audit could only see one of ten sheets

The accessibility half of the Lighthouse pass found one thing, and finding it was worth more
than the score: `--ink-faint` at **3.52:1** on the default beige, against the 4.5:1 that WCAG
AA asks for text at 12px. It carries the front page's dateline, the reading view's byline and
crumb, and the provenance line added a moment earlier — all of it small, none of it exempt.

The useful part is what the audit could not see. It runs against the page as loaded, and the
page as loaded has one of five papers and one of two themes. Checking the rest by hand:

| | worst ratio | |
| --- | --- | --- |
| `--ink-faint`, light, across five papers and their sunken variants | **2.99** | on sunken lilac |
| `--ink-faint`, dark, across its three surfaces | **3.12** | on raised |

So the real worst case was half a point below what was reported, on a sheet the audit never
loaded, and **dark mode failed on all three of its surfaces without being measured at all**.
`--ink` and `--ink-muted` are comfortable everywhere — 15.18 and 6.36 at worst — which is why
this went unnoticed: the palette looks obviously fine until the one value that isn't gets
measured on the one sheet that is worst for it.

Now `#6b645b` light and `#8f867b` dark, each chosen against its worst surface rather than its
default one: 4.67 and 4.85. Accessibility went 92 → 100 on the front page.

`test/contrast.test.ts` is the part worth keeping. It reads the tokens straight out of
`theme.css` and asserts all thirty ink-on-surface combinations, so the next palette change
cannot pass by being tested on beige. Two guards beyond the ratios: the two dark blocks —
`prefers-color-scheme` and `data-theme='dark'` — must stay identical, since a fix applied to
one of them is a bug that appears only for a reader whose OS disagrees with their explicit
choice; and the ink hierarchy must hold, because making every ink the same colour would
satisfy every ratio and destroy the design. Both were checked by breaking them.

### The opening paragraph a publisher never gets to keep

First real use turned up an article missing its first paragraph. Not truncated, not
paywalled — extraction reported "looks complete" and the piece simply started at its
second sentence.

The cause is structural rather than per-site. Readability returns the container with the
highest density of paragraphs, and a standfirst is routinely one `<h2>` in an `<hgroup>`
beside the body — headline, standfirst, byline, date — where it scores nothing, because
headings are discounted and there is only one block of prose in the group. So it is
dropped on every article that publisher runs, and nothing about the output looks wrong.

`restoreMissingIntro` was supposed to cover this and could not: it compares against the
bookmark's excerpt, which Instapaper often leaves empty, and it restores the excerpt
rather than the paragraph. `findLede` recovers the real thing from the source page.

The rule stays on the right side of **a signal, never a publisher**: it keys on the
vocabulary newsroom CMSs use — `standfirst`, `intro`, `lede`, `lead`, `chapeau`, `perex`,
`dek` — in `data-testid`, `class`, `id` or `itemprop`. A publisher that renames its
classes stops being handled, which is a real cost; a hostname list would instead be
silently wrong for every site not on it, which is a worse one.

Four things the real page taught that a synthetic one would not have:

- **Whole tokens, never substrings.** The Dutch `ontdek-meer` contains `dek` and
  `leaderboard` contains `lead`. And the split has to handle camelCase, because the class
  actually on the page is `story-intro_storyIntro__7SJ5Q` — a bundler hash whose only
  meaningful half is glued to the rest.
- **Order is load-bearing.** `Readability.parse` mutates the document it is handed, so the
  `<hgroup>` is gone by the time it returns. Reading the standfirst afterwards finds
  nothing on every page, and looks exactly like a publisher that has none.
- **`textContent` is the wrong accessor.** The standfirst opened with a dateline in its own
  element, and `textContent` concatenated them into `BRUSSELAnderlecht`. Replacing tags
  with spaces first is what keeps the word break the page shows.
- **The duplicate is worse than the omission.** Plenty of publishers put the standfirst
  inside the body, where Readability keeps it; prepending there prints the opening
  paragraph twice, which reads like the publisher repeating itself rather than like our
  bug. `restoreLede` compares normalised words before inserting anything.

Verified against the page that prompted it — 5,266 → 5,667 characters, opening restored —
and against every committed fixture, which are unchanged, since none carries the markup.

**And it does not fix the article that prompted it**, which is the more useful finding. That
article had no extraction stored: `get_text` returned it complete enough to pass the
truncation heuristic, so the reading view was showing Instapaper's copy and our extractor
had never run. The standfirst was missing because *Instapaper* dropped it. The fix above is
real and the diagnosis of Readability's behaviour is correct; it simply addresses a path
this article was not on.

Nothing on screen said so, and that is the actual defect. `readBestText` prefers our
extraction silently and correctly, the **Original** toggle renders only when an extraction
exists to toggle to, and so the one article where "which copy am I reading?" matters most is
the one that answers it least. A provenance line now renders unconditionally under the
headline — the host, linked to the publisher's page, and whether the text came from
Instapaper or from us. It cost a session of debugging to learn that this was unknowable
from the interface.

Two consequences worth carrying:

- **A stored extraction is never refreshed when the extractor improves.** Every fix from
  here is invisible on articles already cached, and there is no way to force a re-run: the
  "Full text" button is gated on `needsExtraction`, which is false for anything that already
  reads as complete. Open.
- **The extraction-time cleaners never touch `get_text` output.** They run in `api/extract`
  only, so an article Instapaper returns complete gets furniture removal at render and
  nothing else. Whether they should is a real question — it would need a re-sync to apply
  to what is cached — but "our cleaners only clean our own extraction" is not a rule anyone
  would have chosen deliberately. Open.

### The store had a shape the design had not allowed for

The first deployment to actually attach a store attached Redis Cloud, and Settings said no
store was attached. Both were right. `lib/kv.ts` spoke Redis over HTTP and nothing else,
on the reasoning that a serverless invocation is short and stateless and an HTTP request
fits it exactly — which is true, and which quietly assumed every managed Redis offers an
HTTP endpoint. Upstash and Vercel KV do. Redis Cloud, ElastiCache and a plain server do
not: they hand you a `redis://` URL and that is all there is.

So there are two transports now. `restKv` is unchanged and still preferred — stateless, no
connection to go stale while the container is frozen, no handshake on a cold start.
`tcpKv` is the other one, and the cost it carries is the connection: one per URL cached for
the life of the process, `lazyConnect` so importing the module opens nothing, and a
five-second `commandTimeout` because the failure that matters is not a refused connection
but one that died while the container slept and would otherwise hang the request. HTTP
wins when both are configured.

It costs a dependency, which this module was proud of not having. `ioredis` rather than a
hand-rolled RESP client, because the thirty-lines-of-fetch argument does not carry over:
this connection carries the reader's publisher session cookies, and TLS, AUTH and protocol
framing are not places to be inventive to save a dependency.

Two things are worth carrying forward:

- **The diagnostic outlived the fault.** `describeKvEnv` had just been written to explain
  that a `redis://` string is why no store was found. One commit later that sentence was
  false — a connection string is now a working store, so a deployment with one never
  reaches the function that says it. It is deleted rather than reworded. A message that
  describes a fault the code no longer has sends the next reader to check something
  already correct, which is the same hour the message was written to save.
- **The stub proved the shape, not the protocol.** `kv.test.ts` drives `tcpKv` against a
  Map to reach the cursor and error paths a healthy server will not produce on demand, and
  that is all it can honestly claim. `kv-redis.test.ts` drives a real `redis-server`:
  round-tripping ciphertext, `null` for an absent key against the empty string, 500 keys
  across a real SCAN cursor, prefix isolation, and a publisher session stored and listed
  end to end with the raw blob read back off the wire to confirm no cookie name or value
  is in it. It is opt-in on `STASH_TEST_REDIS_URL` and **skipped visibly** rather than
  silently, because a test that vanishes with its dependency reads exactly like one that
  passed. The prefix-isolation assertion was checked by breaking the filter and watching
  it fail.

### The deploy log was worth reading

The first real deployment produced four build warnings. Three were noise — an unbounded
`engines.node` range, a deprecated `glob` reached only through `workbox-build`, and npm asking
whether esbuild's postinstall may run (it need not: the platform binary arrives as one of 26
optional dependencies). The fourth was Vite saying a chunk had passed 500 kB, which reads like the
same kind of boilerplate and was not.

**Nearly a third of the client bundle was a second DOM.** `Reader.tsx` imported `removeFurniture`
from `cleaners.ts`, and a bundler follows a module's imports rather than the export you asked for,
so that one line pulled in linkedom and its parser stack — htmlparser2, css-select, cssom, domutils,
css-what — to give a browser a DOM it already has. Attributing the bundle's bytes through a
sourcemap put it at roughly 470 KiB unminified. Splitting furniture removal into `furniture.ts`, on
the platform's own `DOMParser`, took the chunk from **600.00 kB to 411.13 kB** (197.37 → 131.34 kB
gzipped) and the precache from 1062 KiB to 878 KiB. The 500 kB warning is gone with it.

The split is not a new idea imposed on the module — it is the seam the file already documented.
Three cleaners run at extraction, in a function, where linkedom is the only DOM available; the
fourth was always described as running "at render, not at extraction", which means in a browser.
Only the file boundary is new.

Two things are worth carrying forward from it:

- **A parser swap has to be proved on the parser that will run it.** The unit tests moved to jsdom,
  but jsdom is not Chromium. Both implementations were run over the same inputs — the five committed
  `get_text` fragments, both extraction outputs, and a set of shapes chosen to stress a parser — and
  compared byte for byte: 17 of 19 identical. The two that differed were a `<tbody>` Chromium
  inserts per spec and `&nbsp;` where linkedom writes `&#160;`; feeding both forms to a browser
  showed identical DOM, text and codepoints, so the difference disappears at the moment the string
  reaches the DOM, which is the only place it is going. The first attempt also compared the wrong
  thing — whole fixture pages, which `removeFurniture` never receives — and "differs" was the right
  answer to a question production never asks.
- **Nothing failed, and that is why it needs a test rather than a comment.** The app worked, the
  suite passed, and the only symptom was one line in a log. `test/client-bundle.test.ts` walks the
  import graph from `main.tsx` and fails, naming the path, if a server-only package becomes
  reachable again. Its first run failed on a sentence in a doc comment that quoted the very import
  it exists to prevent — `module-resolution.test.ts` had the same flaw latent in it — so both now
  strip comments before matching. A scanner that reads prose as code makes documenting a rule break
  the rule.

---

## Open questions

All prior blockers are cleared: the Instapaper credentials are in hand, the extraction method is
specified in [`docs/EXTRACTION.md`](docs/EXTRACTION.md), and xAuth is confirmed. What remains are
product decisions and two questions that first real use put on the table.

> **Resolved 2026-08-31 — xAuth on the consumer key.** `npm run connect` completed and returned a
> token pair. That single result confirms three things at once: xAuth is enabled on the consumer key,
> the OAuth 1.0a signing is correct against a real server and not only against the RFC, and the
> account is reachable. It was the last item on the critical path that was outside our control.

1. **Is the cookie paste tolerable?** ~~Settled in principle but not in practice.~~ **Answered in
   use.** Sessions for several regularly-read publishers have been pasted into a real deployment,
   and the step was not what got in the way — so **7c stays deferred indefinitely**. What the
   exercise did surface was a setting-up problem rather than a pasting one: the screen said no store
   was attached while a perfectly good one sat there, which is `describeKvEnv` and the TCP transport
   below.
2. **Should the extraction-time cleaners run over `get_text` output?** New, and the sharpest thing
   first use turned up. They live in `api/extract`, so an article Instapaper returns complete gets
   furniture removal at render and nothing else — no duplicate-title strip, no intro restore, no
   standfirst recovery. "Our cleaners only clean our own extraction" is not a rule anyone chose; it
   is where the code happened to put them. Two obstacles, and they are why this is a question rather
   than a task: `findLede` needs the *source page*, which `get_text` output is not, so that one
   cannot simply be moved; and applying the others to stored text needs a re-sync or a migration to
   reach anything already cached.
3. ~~**How does a cached extraction pick up an improved extractor?**~~ **Half answered.** The
   small version is built: **Re-extract** appears whenever an extraction is stored, so one article
   can be refetched against an improved extractor. The thorough version — a stored extractor
   version that invalidates every cached extraction when the rules change — is not, and its cost
   depends on how often those rules actually change, which a few weeks of use will say better than
   an argument will.
4. **Does a large queue need a browsable index?** Raised by Phase 5. The front page shows fourteen
   articles: four in image slots and ten in the sidebar lists. That is deliberate and it is what a
   front page is — but on a queue of fifty it means thirty-six unread articles are on no screen in
   the app, reachable only by refreshing until the shuffle happens to surface them. The spec
   describes no other view, so this is a product decision rather than an oversight to fix: either
   the front page is the whole app and a deep queue is meant to be sampled rather than worked
   through, or there is an "all unread" list behind it. Worth deciding from use, once there is a
   real queue in it.

## Risks

- **Instapaper remains the single point of failure.** The credentials are in hand, but the Full API
  is still a third-party dependency on a service that has changed hands more than once. Nothing to
  do about it beyond keeping the extraction path independent of Instapaper, which it is.
- **Secrets in the wrong place.** The consumer key/secret, the OAuth token, the passphrase and the
  encryption key are all env vars, and the deploy step verifies none of them reach the client
  bundle. Anything that ends up in a chat, an issue or a commit should be reissued rather than
  reasoned about.
- ~~**Column pagination on mobile Safari** is the biggest engineering risk.~~ **Retired 2026-09-07.**
  The worry was that dynamic viewport height and touch momentum would defeat the deterministic
  measurement approach, and that the fallback — vertical scroll on narrow viewports, paginated
  columns on tablet and desktop — would have to be reached for. It did not: the app has been read on
  an Android phone and on a tablet in Safari and paginates smoothly on both. The pagination model
  stays the point, as the spec has it.
- **Article HTML is untrusted input**, from `get_text` and doubly so from our own extraction.
  Sanitize before injecting. Easy to skip, hard to notice.
- **A public URL in front of a destructive API.** The passphrase gate is the only thing between the
  internet and an account someone can delete bookmarks from. It needs to be in place before the
  first deploy, not after — get Phase 2's guard right.
- **Site cookies raise the stakes on that gate.** Once Phase 7b lands, the KV store holds live
  sessions for the user's paid publisher accounts. A weak passphrase, a cookie-value read path that
  should never have existed, or a domain-match bug that sends one publisher's session to another
  host all turn a reading app into a credential leak. The domain matcher gets adversarial unit tests
  before it has a single caller, and cookie values never travel back to the client.
- **Third-party fetching at scale.** A first sync on a large account fires a lot of outbound
  requests. Bounded concurrency plus the permanent negative cache keeps it to a one-time cost, but
  get the guard rails in before running it against a real account.
- **No cross-device cache**, beyond the shared image results. Deliberate, but it means each new
  device re-syncs bookmarks and re-fetches text from scratch. Cheap, and not worth a backend.
- **Extraction has a hard ceiling.** JavaScript-rendered paywalls, anti-bot challenges and
  token-bearer content APIs are all out of reach for an HTML parser, cookies or not. The fallback
  for those is opening the article in a browser, not a cleverer extractor — and it's worth measuring
  per article rather than per domain, since free and premium pieces from the same publisher often
  behave differently.
