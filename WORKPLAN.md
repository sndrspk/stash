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
a KV namespace, not a database — and it is worth one, rather than dragging auth back in.

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
- [ ] Capture a fixture set: ~20 real bookmark records and 5–6 `get_text` HTML payloads (one short,
      one very long, one image-heavy, one with wide embeds/tables, one soft-paywalled where
      `get_text` returns a stub, one hard-paywalled where nothing will help) in `fixtures/`, so the
      front page, reading view and extraction fallback can be built and tested without live API
      access.

**Done when:** fixtures committed.

---

## Phase 1 — Project skeleton

- [ ] `npm create vite@latest` — React + TypeScript. ESLint + Prettier + a `tsc --noEmit` script.
- [ ] Routing: `/` (front page), `/read/:bookmarkId`, `/settings`, `/unlock`.
- [ ] `vite-plugin-pwa`: manifest, icons, service worker registration, install prompt handling.
- [ ] Base theme layer: CSS custom properties, light/dark, and the four reading fonts (Source Serif
      4, Crimson Pro, Piazzolla, Geist) **self-hosted** rather than loaded from
      `fonts.googleapis.com` — self-hosting keeps offline reading working and drops a third-party
      request per page load.
- [ ] Vercel project config; `vercel dev` runs the app and functions together locally.
- [ ] CI: GitHub Actions running lint + typecheck + build on push.

**Done when:** `npm run build` produces an installable PWA that loads an empty shell, `vercel dev`
serves it with a stub function responding, and CI is green.

---

## Phase 2 — Credentials and the gate

- [ ] `scripts/connect.ts` (`npm run connect`): prompts for email + password, performs the xAuth
      exchange against `/api/1/oauth/access_token` with HMAC-SHA1 signing, prints the token/secret
      as ready-to-paste env lines, stores nothing, logs no password.
- [ ] `lib/oauth.ts`: OAuth 1.0a request signing, shared by the script and the functions.
      Signature-base-string construction (percent-encoding, parameter sorting) is where these
      break — **unit-test it against the RFC 5849 worked example** before pointing it at Instapaper.
- [ ] `/unlock` screen + `api/unlock`: compares against `STASH_PASSPHRASE` in constant time, sets a
      signed httpOnly `SameSite=Lax` session cookie. Rate-limit the attempts.
- [ ] Shared `requireSession()` guard, applied to every function. A missing or bad cookie returns
      401 before any outbound call.
- [ ] `.env.example` documenting all five variables; `.env` git-ignored.
- [ ] `/settings` shows connection status (a cheap authenticated Instapaper call) and explains that
      reconnecting means re-running the script — there is no in-app credential write path.

**Done when:** the script yields a working token, an authenticated function call round-trips to
Instapaper, and an unauthenticated request to any function is refused.

---

## Phase 3 — Data layer and sync

- [ ] IndexedDB schema (via `idb`):
      - `bookmarks` — `bookmark_id` (key), `title`, `url`, `time`, `description`, `hash`, `folder`,
        `state` (unread/archived/deleted), `synced_at`, `purge_after` (nullable).
      - `article_text` — `bookmark_id` (key), `html`, `source` (`instapaper` | `extracted`),
        `fetched_at`.
      - `image_cache` — source URL (key), `image_url` (nullable), `status` (`ok`/`none`/`error`),
        `resolved_at`. A `none` row is a permanent negative result and must never be retried.
- [ ] `api/bookmarks`: proxies the bookmark list for the `unread` folder.
- [ ] Client sync: upsert into IndexedDB, reconcile removals (a bookmark gone from Instapaper is
      marked, not silently dropped).
- [ ] `api/archive` and `api/delete`: one bookmark, one action, called only from an explicit user
      click. There is deliberately no batch endpoint.
- [ ] Optimistic archive/delete with rollback on failure; sets `purge_after = now + 7 days` on the
      cached text and image rows.
- [ ] Purge sweep on app start: drop cached text/images past `purge_after`. Undoing an action before
      the deadline clears the mark and keeps the cache.
- [ ] TanStack Query over the IndexedDB layer for the front-page and reading-view reads.

**Done when:** the bookmark list round-trips, archiving in Stash is visible in Instapaper's own web
UI, and the purge sweep drops exactly the rows past their grace period and no others.

---

## Phase 4 — Image resolution

- [ ] `api/resolve-image`: given a bookmark's source URL, fetch the page, parse `og:image`, fall
      back to the first `<img>`, return the result (including "none") for the client to cache.
- [ ] **SSRF guard — required, not optional.** This function fetches an arbitrary URL from our
      infrastructure. Restrict to `http`/`https`; resolve the host and reject private, loopback,
      link-local and cloud-metadata addresses; cap redirects and re-validate every hop; cap the
      response size; set a hard timeout. Refuse any `instapaper.com` host outright — the terms
      forbid scraping it, and a source URL should never point there.
- [ ] Bounded concurrency (start at 3–4 in flight) with a per-host delay, so a sync of 200 bookmarks
      doesn't hammer any one site.
- [ ] Never re-fetch a URL that already has a cache row, positive or negative.

**Done when:** a full sync resolves images once, a second sync resolves zero, and a URL pointing at
`169.254.169.254` or `localhost` is rejected before any fetch happens.

---

## Phase 5 — Front page

- [ ] Layout: hero (image + title + excerpt), three secondary cards with images, sidebar with
      5-oldest and 5-newest unread title-only lists.
- [ ] Slot selection: hero and three secondaries picked at random from unread bookmarks that have a
      resolved image. Image-less bookmarks are excluded from those four slots only.
- [ ] Excerpts: `description` when present, else derived from fetched text for the four slot
      articles (fetch those four eagerly; everything else stays lazy).
- [ ] Responsive: the newspaper grid collapses to a single column on phones, hero stays the hero,
      sidebar lists move below the fold rather than into a drawer.
- [ ] Empty, loading (skeletons) and error states. Zero-unread is a real state and needs a design.
- [ ] Pull-to-refresh and an explicit refresh action, both triggering a sync.

**Done when:** the front page renders from fixtures and from live data, reshuffles on refresh, and
never shows an image-less article in an image slot.

---

## Phase 6 — Reading view

The highest-risk phase. Section 4 of the spec is the specification; it encodes bug fixes that cost
real iteration in the native app, and reverting to naive CSS multi-column will reintroduce them.

- [ ] `api/text`: `get_text` via the API, cached client-side. **Sanitize the returned HTML**
      (DOMPurify or equivalent) before injecting it — it is third-party content.
- [ ] Multi-column horizontal pagination with the **deterministic column count** algorithm:
      measure natural height at `columnCount: 1`, compute
      `columnCount = ceil(naturalHeight / availableColumnHeight)`, then set an explicit width of
      `columnCount * (columnWidth + gap) - gap + horizontalPadding`. Do not let the browser
      auto-fit — that is what causes end-of-article text to bleed past the padding.
- [ ] Re-measure on every image `load` event, on resize, and on any typography preference change.
- [ ] Snap-to-column after scroll settles (~140ms debounce), measuring the *rendered* column stride
      from the DOM rather than trusting the CSS value; the first column snaps back to
      `scrollLeft: 0`.
- [ ] Typography preferences: font family, size, line height, column width (Narrow 22em / Medium
      34em / Wide 56em, default Medium). Persisted in IndexedDB, sticky across articles and
      sessions. (Per-device now — there is no backend to sync them through.)
- [ ] `--reading-column-width` clamp on `img`, `video`, `iframe`, `table`, `pre` in the body.
- [ ] `orphans: 2; widows: 2;` on paragraphs and list items.
- [ ] Touch: swipe left/right for page turns; tap zones as a secondary affordance. Keyboard: arrow
      keys and space on desktop.
- [ ] Per-article archive and delete, plus close-to-home.
- [ ] **Verification test:** on a long article, assert `scrollWidth ===` the content box's computed
      width exactly. That 0px check is the regression test for the whole approach.

**Mobile caveat to design around:** `100vh` and dynamic viewport height on iOS Safari change as the
address bar collapses, which changes `availableColumnHeight` and therefore the column count
mid-read. Use `100dvh`, and debounce re-measures so a scroll-triggered chrome collapse doesn't
reflow the article under the reader's finger. Budget real time for this — it is the most likely
source of "works on desktop, broken on my phone".

**Done when:** a long, image-heavy article paginates correctly on desktop and on a real phone, the
0px check passes, and preferences apply live without losing the reader's position.

---

## Phase 7 — Extraction fallback

Full detail in [`docs/EXTRACTION.md`](docs/EXTRACTION.md). Build it in that document's own staged
order — each stage is independently useful, which is what made it tractable on Android.

**Built ahead of the phases it belongs to**, because it answers the riskiest product question — is
the manual cookie paste worth doing? — before anything depends on the answer. `npm run probe`
fetches an article anonymously and authenticated and reports the difference. See
[`docs/COOKIE_SETUP.md`](docs/COOKIE_SETUP.md).

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
        login cookie. Expectations in `docs/COOKIE_SETUP.md` should say so.
- [ ] The four cleaners as separate pure functions over the fragment (`linkedom`): duplicate title,
      missing intro, page furniture, hero image. Furniture removal runs **at render time**, so a new
      rule fixes already-cached articles without a re-sync.
- [ ] Store beside, never over: `article_text` keeps both sources, a derived accessor picks
      `extracted ?? instapaper`, and settings gets a "show original" toggle for free.
- [ ] Gating: run only when `get_text` output trips the heuristic. Retry backoff (one week) **in
      code, not in the query**. Single-flight try-lock around the pass. An explicit "fetch full
      content" action bypasses every gate.

**Done when:** a soft-paywalled article that Instapaper returned a stub for renders in full, and a
hard-paywalled one fails with a legible tag rather than an exception.

### 7b — Manual site sessions

- [x] `src/lib/cookies.ts`: RFC 6265 matching — `U == H` or `U` ends with `.H` — plus header
      parsing, last-wins merge, and a names-only accessor for anything user-facing. Tested
      adversarially before it had a caller: spoofed suffixes, substring hosts, leading dots, case,
      values containing `=`, IP literals, single-label hosts. That suite caught a real bug on first
      run (a saved `168.1.1` dot-suffix-matching the host `192.168.1.1`), which is the argument for
      writing it first.
- [x] Cookies are dropped on a cross-host redirect rather than forwarded — a session must never
      follow a bounce to a third party.
- [ ] KV binding + `lib/secrets.ts`: AES-GCM under `STASH_ENCRYPTION_KEY`, corrupt-blob recovery
      deletes and recreates rather than crashing. **Separate namespace from anything Instapaper.**
      (The probe reads a git-ignored `sessions.txt` in the meantime — same shape, no encryption.)
- [x] `scripts/session.ts`: add/list/remove from the CLI, reading the header from stdin so it stays
      out of shell history. The dry run for Phase 7b's settings screen, and it enforces the same
      rule: values go in, only names come out.
- [ ] `api/sessions`: POST a host + `Cookie:` header value, DELETE one host, GET the host list.
      Only `name=value` pairs are stored; everything else is dropped. **The cookie values are never
      returned to the client** — GET lists hosts and nothing more.
- [ ] Settings UI: add a session (host + paste), per-host sign-out, list of signed-in hosts, and a
      line explaining where to get the value (devtools → Network → copy the `Cookie` request
      header). Note plainly that this is a desktop-only step that benefits every device.
- [ ] Attach the jar to the extractor. With an empty store this changes nothing at the wire level —
      the safe one-line change SanFeedBin's build order relies on.
- [ ] The expired-session diagnostic: extraction succeeded, output still trips the heuristic, and
      cookies were sent for that host → surface "session may have expired" with a re-paste action.
      **Do not auto-clear** — one bad extraction is not proof a session is dead.

**Done when:** pasting a session for a publisher you subscribe to turns one of its stub articles
into a full one, and clearing that session returns it to a stub.

### 7c — Browser extension (optional, deferred)

One-click cookie capture, the real equivalent of the Android WebView flow. Separate deliverable,
own store review. Build only if the paste step is what stops you using Stash.

---

## Phase 8 — Offline and PWA polish

- [ ] Service worker: precache the app shell; runtime-cache article images.
- [ ] Offline reads work from the IndexedDB cache with no network.
- [ ] Offline archive/delete: queue the intent, replay on reconnect, show clearly that the action is
      pending. (Still one explicit click per item — queuing is not batching.)
- [ ] Manifest, icons, splash screens, `theme-color`, iOS install metadata.
- [ ] Lighthouse PWA + performance pass.

**Done when:** the app installs on iOS and Android, opens offline, and shows a previously-read
article with no network.

---

## Phase 9 — Settings, hardening, ship

- [ ] Settings: connection status, appearance/theme, cache size, clear cache.
- [ ] Error surfaces: an expired or revoked Instapaper token prompts to re-run `connect`, rather
      than failing silently.
- [ ] Per-session rate limiting on the functions.
- [ ] Deploy: env vars set as Vercel secrets, none of them exposed to the client bundle. Verify by
      grepping the built output for the token.
- [ ] README deploy guide good enough that someone else can fork, run `connect`, deploy and use it.
- [ ] Final terms-of-use review against the constraint list in the README.

---

## Open questions

Both prior blockers are cleared: the Instapaper credentials are in hand, and the extraction method
is specified in [`docs/EXTRACTION.md`](docs/EXTRACTION.md). What remains is one confirmation and one
preference.

1. **xAuth on the consumer key.** Granted per-application and separately from Full API access, and
   it fails only at the token exchange. The first `npm run connect` run confirms it; if it 401s,
   that is a request back to Instapaper, not a bug in our signing (assuming the RFC 5849 test vector
   passes first).
2. **Is the cookie paste tolerable?** Settled in principle — manual paste first, extension deferred
   to 7c — but not yet in practice. Run `npm run probe` against two or three publishers you
   subscribe to and see. If the copy step is fine, 7c stays deferred indefinitely; if it's the thing
   that stops you using Stash, it moves up.

## Risks

- **Instapaper remains the single point of failure.** The credentials are in hand, but the Full API
  is still a third-party dependency on a service that has changed hands more than once. Nothing to
  do about it beyond keeping the extraction path independent of Instapaper, which it is.
- **Secrets in the wrong place.** The consumer key/secret, the OAuth token, the passphrase and the
  encryption key are all env vars, and the deploy step verifies none of them reach the client
  bundle. Anything that ends up in a chat, an issue or a commit should be reissued rather than
  reasoned about.
- **Column pagination on mobile Safari** is the biggest engineering risk. The
  deterministic measurement approach is right, but dynamic viewport height and touch momentum will
  need iteration. Fallback if it proves untenable on phones: vertical scroll on narrow viewports,
  paginated columns on tablet and desktop. Don't reach for this early — the spec is explicit that
  the pagination model is the point.
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
