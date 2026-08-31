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

### No accounts, no database

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
boilerplate, Stash re-extracts from the source URL itself using the method from the Sanfeedbin
Android project. **⚠ blocked** — see [Open questions](#open-questions-and-blockers).

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

**⚠ Blocker: Instapaper Full API credentials.** The Full API (bookmark list, `get_text`, `archive`,
`delete`) and the xAuth exchange both require a consumer key/secret that Instapaper issues manually
on request, and xAuth has to be enabled per-application. Without it, nothing past Phase 2 can be
tested against real data. Request it first — turnaround is out of our control. Until it arrives,
Phases 1 and 3 (shell, cache layer) and the fixture-driven parts of Phase 6 (reading view) can
proceed.

- [ ] Request Instapaper Full API consumer key/secret + xAuth permission.
- [ ] Obtain the Sanfeedbin extraction method (see open questions).
- [ ] Capture a fixture set: ~20 real bookmark records and 4–5 `get_text` HTML payloads (one short,
      one very long, one image-heavy, one with wide embeds/tables, one where `get_text` fails on a
      paywall) in `fixtures/`, so the front page, reading view and extraction fallback can be built
      and tested without live API access.

**Done when:** credentials requested and fixtures committed.

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
- [ ] Extraction fallback: when `get_text` returns empty, a stub, or paywall boilerplate, re-extract
      from the source URL using the Sanfeedbin method. Same SSRF guard as Phase 4. Record which
      source produced the text so failures are debuggable. **⚠ blocked on the method.**
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
0px check passes, preferences apply live without losing the reader's position, and an article
Instapaper failed to extract renders via the fallback.

---

## Phase 7 — Offline and PWA polish

- [ ] Service worker: precache the app shell; runtime-cache article images.
- [ ] Offline reads work from the IndexedDB cache with no network.
- [ ] Offline archive/delete: queue the intent, replay on reconnect, show clearly that the action is
      pending. (Still one explicit click per item — queuing is not batching.)
- [ ] Manifest, icons, splash screens, `theme-color`, iOS install metadata.
- [ ] Lighthouse PWA + performance pass.

**Done when:** the app installs on iOS and Android, opens offline, and shows a previously-read
article with no network.

---

## Phase 8 — Settings, hardening, ship

- [ ] Settings: connection status, appearance/theme, cache size, clear cache.
- [ ] Error surfaces: an expired or revoked Instapaper token prompts to re-run `connect`, rather
      than failing silently.
- [ ] Per-session rate limiting on the functions.
- [ ] Deploy: env vars set as Vercel secrets, none of them exposed to the client bundle. Verify by
      grepping the built output for the token.
- [ ] README deploy guide good enough that someone else can fork, run `connect`, deploy and use it.
- [ ] Final terms-of-use review against the constraint list in the README.

---

## Open questions and blockers

1. **⚠ Instapaper Full API credentials** — outstanding, and the gate on everything past Phase 2.
   See Phase 0.
2. **⚠ The Sanfeedbin extraction method.** I have no access to that project — it is local to your
   machine and not on GitHub, and I can't read your other chats. To port it, paste the relevant
   source files (the fetch/extraction path: request headers used, HTML parsing, readability step,
   and any per-site special-casing) or an export of that conversation. Until then Phase 6's
   fallback is stubbed. If it turns out to be plain Readability-on-raw-HTML, that is quick; if it
   carries per-site rules, they'll need porting one at a time.
3. **Extraction posture.** Worth a deliberate choice, since it shapes the code: re-parsing the HTML
   a server already sent us (getting under a client-side paywall overlay) is a different thing from
   spoofing a crawler user-agent or routing through an archive mirror to obtain content the site
   withheld. The former is comfortable; the latter is a publisher-ToS question you should decide
   knowingly rather than inherit by accident. Tell me which line you want and I'll build to it.

## Risks

- **Instapaper API access is the single point of failure.** No credentials, no app. It is outside
  our control and Instapaper has changed hands more than once — confirm the Full API is still being
  issued before investing in Phases 3–6.
- **Column pagination on mobile Safari** is the biggest engineering risk after that. The
  deterministic measurement approach is right, but dynamic viewport height and touch momentum will
  need iteration. Fallback if it proves untenable on phones: vertical scroll on narrow viewports,
  paginated columns on tablet and desktop. Don't reach for this early — the spec is explicit that
  the pagination model is the point.
- **Article HTML is untrusted input**, from `get_text` and doubly so from our own extraction.
  Sanitize before injecting. Easy to skip, hard to notice.
- **A public URL in front of a destructive API.** The passphrase gate is the only thing between the
  internet and an account someone can delete bookmarks from. It needs to be in place before the
  first deploy, not after — get Phase 2's guard right.
- **Third-party fetching at scale.** A first sync on a large account fires a lot of outbound
  requests. Bounded concurrency plus the permanent negative cache keeps it to a one-time cost, but
  get the guard rails in before running it against a real account.
- **No cross-device cache.** Deliberate, but it means each new device re-syncs and re-resolves
  images from scratch. If that becomes annoying, the smallest fix is a KV store on the hosting
  platform for `image_cache` only — not a return to a full backend.
