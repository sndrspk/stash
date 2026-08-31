# Article Reader — Design Spec (for porting to Vite + React + TypeScript + Supabase PWA)

> **Note (added on import):** this document was written by Glaze about the existing native macOS
> app and is preserved here essentially verbatim as the product source of truth. The PWA being
> built from it is named **Stash**. Where this document says "the new app", read "Stash".
> Deviations from this spec are tracked in [`../WORKPLAN.md`](../WORKPLAN.md), which also lists
> open questions this spec does not settle.

Source of truth: an existing native macOS app ("Article Reader" / working name "Newsprint"), an
Instapaper reader. This document captures the product and technical decisions made while building
it, so they can be reproduced on a different stack. It is a spec, not code — the new app's
implementation will necessarily differ (see "Porting notes" at the end for the biggest structural
change required).

## 1. Product overview

A read-it-later client for Instapaper with a newspaper-style home page instead of a plain list.

- **Home page** looks like a newspaper front page:
  - One large randomly-chosen featured article (image + title + excerpt).
  - Three secondary articles below it, each with an image.
  - A sidebar with two title-only lists: 5 oldest unread bookmarks, 5 newest unread bookmarks.
  - Articles with no recoverable image are excluded from the four image-slot positions (hero + 3
    secondary) — they can still appear in the sidebar lists.
- **Reading view**: clicking any article opens a dedicated reading screen with the full article
  text, a close action (back to home), archive, and delete. Archive/delete are per-article, one
  click each — no bulk actions.
- **Sync model**: archiving or deleting in the app performs the same action on Instapaper via its
  API (not just locally). New bookmarks added to Instapaper (e.g. from a phone/browser extension)
  show up in the app on next refresh. The app never creates bookmarks itself.

## 2. Instapaper API integration

- **Auth: OAuth 1.0a "xAuth"**, not OAuth2/browser redirect — Instapaper's Full API has no
  browser-based login flow. Flow: user enters Instapaper email + password once, in-app; the app
  exchanges those directly for a long-lived OAuth token/secret via Instapaper's
  `/api/1/oauth/access_token` endpoint (HMAC-SHA1 request signing), then **immediately discards the
  password** — only the resulting token/secret pair is persisted.
- Endpoints used: bookmarks list, `archive`, `delete`, `get_text` (full article HTML).
- **Terms-of-use constraints that shaped the design** (reviewed against Instapaper's API terms):
  - Never store the user's password beyond the single token-exchange request.
  - Never alter/delete a bookmark except via an explicit, per-item user click — no automatic or
    bulk archive/delete.
  - Never scrape instapaper.com pages. `og:image` fetching must only ever hit the bookmark's own
    `url` field (the original third-party source), never any instapaper.com URL.
  - Never auto-create bookmarks (e.g. from an RSS feed) — the app is read/archive/delete only.
  - Product name/branding may not use the word "Instapaper" as the app's own name/logo, but may
    describe itself as "for Instapaper" (e.g. "X for Instapaper").
- **Images**: Instapaper bookmarks carry no thumbnail/image field. The app fetches each bookmark's
  original source URL and scrapes it for an `og:image` meta tag, falling back to the first `<img>`
  in the page if no `og:image` is present. This is done with bounded concurrency (avoid hammering
  many third-party sites at once) and the result is cached — never re-fetched once resolved (or
  once confirmed absent).

## 3. Caching

Three things are cached locally to minimize API calls and repeat scraping work:
- Bookmark list (metadata: id, title, url, time, progress, etc).
- Resolved article text/HTML (`get_text` result) — fetched once per article, reused on reopen.
- Resolved `og:image` URLs (including "no image found" as a cached negative result).

The OAuth token/secret is stored separately from this cache and treated as a secret (see Porting
notes — this used OS-level encrypted storage; the web app needs its own equivalent).

## 4. Reading view — typography & pagination

This is the most detail-sensitive part of the app; several rounds of iteration happened here.

- **Layout model**: the article body is NOT a single vertically-scrolling column. It uses CSS
  multi-column layout (`column-width`/`column-count`) and the user navigates **horizontally**,
  page-by-page — closer to an e-reader/magazine feel than a typical web article scroll.
- **Reading preferences** (persisted, sticky across articles and app restarts):
  - Font family (a small curated list — Source Serif 4, Crimson Pro, Piazzolla, Geist — loaded via
    Google Fonts).
  - Font size.
  - Line height.
  - Column width: **Narrow / Medium / Wide** presets = 22em / 34em / 56em, default **Medium**.
  - Preferences apply live and are the basis for the multi-column width; images/video/iframe/
    table/pre inside the article body are clamped to the current column width via a CSS custom
    property (`--reading-column-width`) so wide embeds never overflow a column.
- **Horizontal scroll-snap (wheel/trackpad navigation)** — this took several bug-fix passes to get
  right, and the final, correct model matters for a faithful port:
  1. A naive `scrollLeft += deltaY` handler with no snapping leaves the view stopped at arbitrary
     pixel offsets *between* column boundaries after trackpad scrolling — text ends up flush
     against both edges mid-column, with partial cut-off words. **Fix**: after scroll settles
     (~140ms debounce), measure the real rendered column stride (columns are browser-balanced, so
     actual width can differ from the requested preference — measure it from the DOM, don't trust
     the CSS value) and smooth-scroll to the nearest column boundary, leaving one column-gap of
     margin, or back to `scrollLeft: 0` for the first column (to preserve the intro padding).
  2. **Root cause of a separate, harder bug**: a CSS multi-column box only ever sizes its own
     border box to fit as many columns as fit its *first* screen-width viewport. Any columns beyond
     that render as pure visual overflow/"bleed" past that edge — completely outside where the
     box's own `padding-right` applies. Net effect: on any sufficiently long article, no amount of
     trailing padding or scroll-snap special-casing ever produced real whitespace at the true end
     of the article — text ran flush to the edge no matter what.
     **Correct fix**: don't let the browser auto-fit-and-bleed columns. Deterministically compute
     the exact column count needed:
     - Temporarily render the real content (not a synthetic clone — real images must count) as a
       single column (`columnCount: 1`, `height: auto`) to measure its true natural height.
     - `columnCount = ceil(naturalHeight / availableColumnHeight)`.
     - Set an **explicit** width = `columnCount * (columnWidth + gap) - gap + horizontalPadding`,
       plus a matching explicit `columnCount`/`columnWidth` — so the box's own formal edge always
       lands exactly where content actually ends, and padding-right is finally real.
     - Re-run this measurement on every image `load` event too (images without explicit dimensions
       can undercount natural height on first pass, before they've loaded).
  - **Widows/orphans**: `orphans: 2; widows: 2;` on paragraphs/list items, so a single stray line at
    a column break pulls a second line along rather than standing alone.
  - Verified end state: for a real long article, `scrollWidth === computedWidth` of the content box
    exactly (0px discrepancy) — i.e. the last visual column genuinely ends with the configured
    trailing padding, not overflow bleed.

## 5. Settings

A dedicated settings surface (separate window in the native app; likely a settings route/panel in
a web app) contains:
- **Instapaper Account**: connect (email/password → xAuth exchange) / sign out.
- **Appearance/Theme** section (existing app theme settings, separate from reading typography
  prefs above, which live inline in the reading view itself via a view-settings dropdown).

## 6. Porting notes — biggest structural change required

The current app's backend runs as a local Node process with unrestricted outbound `fetch` (no
browser CORS policy), and secrets are stored via OS-level encrypted storage. Neither holds in a
browser-hosted PWA:

- **CORS**: Instapaper's API and arbitrary third-party sites (for `og:image` scraping) will not
  serve CORS headers permitting browser-side `fetch` from your PWA's origin. This means the OAuth
  xAuth exchange, all bookmark list/archive/delete/get_text calls, and the `og:image` scraping must
  be proxied through a server you control — a Supabase Edge Function is the natural fit here, since
  Supabase is already in the stack. The PWA calls your Edge Function; the Edge Function calls
  Instapaper and third-party sites server-side.
- **Secret storage**: the OAuth token/secret should not sit in browser localStorage in plaintext
  long-term if avoidable. With Supabase already in play, storing the Instapaper token/secret in a
  Supabase table (RLS-scoped to the authenticated Supabase user) keyed off Supabase Auth, and only
  ever touching Instapaper via the Edge Function (never sending the token to the client), is the
  natural equivalent of the native app's OS-level encrypted storage.
- **Caching**: bookmark list / article text / resolved images can reasonably live in Supabase
  tables (shared across the user's devices, which is actually an upgrade over the native app's
  single-machine local cache) or in IndexedDB for a purely client-side cache layer on top.
- **PWA-specific**: the horizontal, e-reader-style column pagination is viewport-width dependent;
  on mobile this should likely become touch-swipe rather than wheel/trackpad, but the same
  deterministic column-count-measurement approach (section 4, item 2) is what makes trailing
  padding/end-of-article whitespace actually correct, and should be preserved rather than
  reverting to naive CSS multi-column auto-sizing.
- Everything else (auth flow shape, terms-of-use constraints, caching semantics, reading
  preferences, home page layout) is stack-agnostic and can be ported as described above.
