# Stash — Work Plan

Implementation plan for porting the native macOS Article Reader to a Vite + React + TypeScript +
Supabase PWA. The product spec is [`docs/DESIGN_SPEC.md`](docs/DESIGN_SPEC.md); this file is the
build order, the decisions that spec leaves open, and the risks worth knowing before starting.

Working notes for the agent doing the work:

- Phases are ordered by dependency. Each phase ends in something demonstrable — don't start the
  next one until the current one runs.
- Every phase has an explicit "done when" that can actually be checked.
- Anything marked **⚠ blocked** or **❓ open question** needs a human answer before that phase
  starts. Do the unblocked work first; don't guess on these.

---

## Phase 0 — Decisions and prerequisites

**⚠ Blocker: Instapaper Full API credentials.** The Full API (bookmark list, `get_text`, `archive`,
`delete`) and the xAuth token exchange both require a consumer key/secret that Instapaper issues
manually on request, and xAuth in particular has to be enabled per-application. Without it, nothing
past Phase 2 can be tested against real data. Request these first — turnaround is out of our
control. Until they arrive, Phases 1 and 3 (shell, schema) and the fixture-driven parts of Phase 6
(reading view) can proceed against recorded fixtures.

- [ ] Request Instapaper Full API consumer key/secret + xAuth permission.
- [ ] Answer the [open questions](#open-questions) below.
- [ ] Create the Supabase project; record project ref and URL.
- [ ] Capture a fixture set: ~20 real bookmark records and 3–4 `get_text` HTML payloads (one short,
      one very long, one image-heavy, one with wide embeds/tables) checked into `fixtures/` so the
      front page and reading view can be built and tested without live API access.

**Done when:** credentials requested, questions answered, Supabase project exists, fixtures committed.

---

## Phase 1 — Project skeleton

- [ ] `npm create vite@latest` — React + TypeScript. Add ESLint + Prettier + `tsc --noEmit` script.
- [ ] Routing (`/`, `/read/:bookmarkId`, `/settings`, `/login`).
- [ ] `vite-plugin-pwa`: manifest, icons, service worker registration, install prompt handling.
- [ ] Base theme layer: CSS custom properties, light/dark, the four Google Fonts (Source Serif 4,
      Crimson Pro, Piazzolla, Geist) self-hosted rather than loaded from `fonts.googleapis.com` —
      self-hosting keeps offline reading working and avoids a third-party request per page load.
- [ ] CI: a GitHub Actions workflow running lint + typecheck + build on push.

**Done when:** `npm run build` produces an installable PWA that loads an empty shell, and CI is green.

---

## Phase 2 — Supabase auth and the account model

- [ ] Supabase Auth for the Stash account itself. See ❓ *Do we need a Supabase login at all?* —
      the answer decides whether this is email magic-link, or anonymous-auth with an upgrade path.
- [ ] `instapaper_credentials` table: `user_id` (PK, FK → `auth.users`), `oauth_token`,
      `oauth_token_secret`, `instapaper_username`, `created_at`.
- [ ] RLS: owner-only select/insert/update/delete. **The service-role key stays server-side only**;
      the anon client never reads the token columns — the Edge Function is the only reader.
- [ ] Edge Function `instapaper-connect`: takes email + password, performs the xAuth exchange
      against `/api/1/oauth/access_token` with HMAC-SHA1 signing, stores the returned token/secret,
      and returns only success/failure. The password is never logged, never persisted, and never
      leaves the function.
- [ ] `/login` and `/settings` UI for connect and sign-out (sign-out deletes the credential row).

Note: OAuth 1.0a signing has to be implemented in Deno. Signature-base-string construction
(percent-encoding, parameter sorting) is where these break — unit-test it against the RFC 5849
worked example before pointing it at Instapaper.

**Done when:** a real Instapaper account can be connected from the browser, the token lands in the
table, and the plaintext password appears nowhere in the DB, logs, or client bundle.

---

## Phase 3 — Data model and sync

- [ ] Tables (all RLS owner-scoped):
      - `bookmarks` — `user_id`, `bookmark_id`, `title`, `url`, `time`, `progress`, `starred`,
        `hash`, `folder`, `synced_at`, `state` (unread/archived/deleted).
      - `article_text` — `user_id`, `bookmark_id`, `html`, `fetched_at`.
      - `image_cache` — keyed on the bookmark's source URL: `image_url` (nullable), `resolved_at`,
        `status` (`ok` / `none` / `error`). A null `image_url` with status `none` is a cached
        negative result and must not be retried.
- [ ] Edge Function `instapaper-sync`: reads the caller's token, calls the bookmarks list endpoint,
      upserts into `bookmarks`, and reconciles deletions (bookmarks gone from Instapaper are marked,
      not silently dropped).
- [ ] Edge Functions `instapaper-archive` and `instapaper-delete`: single bookmark, single action,
      called only from an explicit user click. No batch endpoint exists on purpose.
- [ ] Client data layer: TanStack Query over the Supabase client, with optimistic archive/delete
      that rolls back on failure.

**Done when:** the bookmark list round-trips, and archiving in Stash is visible in Instapaper's own
web UI (and vice versa after a refresh).

---

## Phase 4 — Image resolution

- [ ] Edge Function `resolve-image`: given a bookmark's source URL, fetch the page, parse `og:image`,
      fall back to the first `<img>`, write the result (including "none") to `image_cache`.
- [ ] **SSRF guard — required, not optional.** This function fetches an arbitrary URL on our
      infrastructure. Restrict to `http`/`https`, resolve the host and reject private, loopback,
      link-local and metadata-endpoint addresses, cap redirects (re-validating each hop), cap
      response size, and set a hard timeout. Also refuse any `instapaper.com` host outright — the
      terms forbid scraping it, and a URL field should never point there anyway.
- [ ] Bounded concurrency (start at 3–4 in flight) with a per-host delay, so a sync of 200 bookmarks
      doesn't hammer any one site.
- [ ] Never re-fetch a URL that already has a row in `image_cache`, in either direction.

**Done when:** a full sync resolves images once, a second sync resolves zero, and a URL pointing at
`169.254.169.254` or `localhost` is rejected before any fetch happens.

---

## Phase 5 — Front page

- [ ] Layout: hero (image + title + excerpt), three secondary cards with images, sidebar with
      5-oldest and 5-newest unread title-only lists.
- [ ] Slot selection: pick the hero and the three secondaries at random from unread bookmarks that
      have a resolved image; exclude image-less bookmarks from those four slots only.
- [ ] Excerpt source — see ❓ *Where do excerpts come from?*
- [ ] Responsive: the newspaper grid collapses to a single column on phones; the hero stays the
      hero. Decide the phone treatment of the sidebar lists (likely below the fold, not a drawer).
- [ ] Empty, loading (skeletons) and error states. Zero-unread is a real state and needs a design.
- [ ] Pull-to-refresh / explicit refresh triggering `instapaper-sync`.

**Done when:** the front page renders from fixtures and from live data, reshuffles on refresh, and
never shows an image-less article in an image slot.

---

## Phase 6 — Reading view

The highest-risk phase. Section 4 of the spec is the specification; it encodes bug fixes that cost
real iteration in the native app, and reverting to naive CSS multi-column will reintroduce them.

- [ ] Fetch and cache `get_text` HTML through an Edge Function; sanitize the returned HTML
      (DOMPurify or equivalent) before injecting it — it is third-party content.
- [ ] Multi-column horizontal pagination with the **deterministic column count** algorithm:
      measure natural height at `columnCount: 1`, compute
      `columnCount = ceil(naturalHeight / availableColumnHeight)`, then set an explicit width of
      `columnCount * (columnWidth + gap) - gap + horizontalPadding`. Do not let the browser
      auto-fit — that is what causes end-of-article text to bleed past the padding.
- [ ] Re-measure on every image `load` event, on resize, and on any typography preference change.
- [ ] Snap-to-column after scroll settles (~140ms debounce), measuring the *rendered* column stride
      from the DOM rather than trusting the CSS value; first column snaps back to `scrollLeft: 0`.
- [ ] Typography preferences panel: font family, size, line height, column width
      (Narrow 22em / Medium 34em / Wide 56em, default Medium). Persisted and sticky across articles
      and sessions; sync them to Supabase so they follow the user across devices.
- [ ] `--reading-column-width` clamp on `img`, `video`, `iframe`, `table`, `pre` inside the body.
- [ ] `orphans: 2; widows: 2;` on paragraphs and list items.
- [ ] Touch: swipe left/right for page turns on mobile; tap zones as a secondary affordance.
      Keyboard: arrow keys / space on desktop.
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

## Phase 7 — Offline and PWA polish

- [ ] Service worker: precache the app shell; runtime-cache article HTML and images.
- [ ] IndexedDB mirror of bookmarks + article text so opening a previously-read article works
      offline.
- [ ] Offline archive/delete: queue the intent and replay on reconnect, with clear UI that the
      action is pending. (Still one explicit click per item — queuing is not batching.)
- [ ] Manifest, icons, splash screens, `theme-color`, iOS install metadata.
- [ ] Lighthouse PWA + performance pass.

**Done when:** the app installs on iOS and Android, opens offline, and shows a previously-read
article with no network.

---

## Phase 8 — Settings, hardening, ship

- [ ] Settings: Instapaper account connect/disconnect, appearance/theme, cache size + clear cache.
- [ ] Error surfaces: expired/revoked Instapaper token → prompt to reconnect, not a silent failure.
- [ ] Rate-limit the Edge Functions per user.
- [ ] Deploy target (see ❓ *Where does the PWA get hosted?*), with the Supabase URL and anon key as
      build-time env vars and the service-role key only ever in Edge Function secrets.
- [ ] Final terms-of-use review pass against the constraint list in the README.

---

## Open questions

Answers needed from you; several change the shape of earlier phases.

1. **Do we need a Supabase login at all?** If Stash is single-user (just you), a Supabase account on
   top of the Instapaper connection is a second login for no benefit. Options: (a) full email
   magic-link auth — correct for multi-user, more friction; (b) Supabase **anonymous auth** —
   device-scoped identity with no login screen, upgradeable later, but a cleared browser means a
   re-connect; (c) multi-user from day one. **Recommendation: (b)** unless you plan to share this
   with others. Everything else in the plan works either way.
2. **Where do excerpts come from?** Instapaper's bookmark list returns a short `description` field,
   but it is often empty. The alternative is deriving the excerpt from the cached `get_text` HTML,
   which means fetching full text for at least the four front-page slots up front rather than
   lazily on open. **Recommendation:** use `description` when present, fall back to fetching text
   for the four slot articles only.
3. **Where does the PWA get hosted?** Vercel, Netlify, Cloudflare Pages, or Supabase's own static
   hosting. Any works; it affects only the Phase 8 deploy step.
4. **Article text retention.** Cached `get_text` HTML is full third-party article content sitting in
   our database. Fine for personal use, and RLS-scoped, but worth deciding a policy: keep forever,
   or purge on archive/delete and after N days unread?
5. **What does "unread" mean here?** The spec's sidebar lists and slot selection are over "unread
   bookmarks", but Instapaper models this as folders (unread / archive / starred) plus a `progress`
   value. Confirm: unread = in the `unread` folder, regardless of `progress`? Or exclude anything
   with `progress > 0.9`?

## Risks

- **Instapaper API access is the single point of failure.** No credentials, no app. It is also
  outside our control and the ownership of Instapaper has changed hands more than once — worth
  confirming the Full API is still being issued before investing in Phases 3–6.
- **Column pagination on mobile Safari** is the biggest engineering risk after that. The
  deterministic measurement approach is right, but dynamic viewport height and touch momentum will
  need iteration. Fallback if it proves untenable on phones: vertical scroll on narrow viewports,
  paginated columns on tablet and desktop. Don't reach for this early — the spec is explicit that
  the pagination model is the point.
- **`get_text` HTML is untrusted input.** Sanitize before injecting. This is easy to skip and hard
  to notice.
- **Edge Function cold starts** on the sync path will make the first refresh after idle feel slow.
  Optimistic UI and skeletons cover it; a warming ping is a later optimization.
- **Third-party image fetching at scale.** A first sync on a large account fires a lot of outbound
  requests. Bounded concurrency plus the permanent negative cache keeps this to a one-time cost, but
  get the guard rails in before running it against a real account.
