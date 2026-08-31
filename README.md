# Stash

A read-it-later PWA for Instapaper, with a newspaper-style front page instead of a plain list.

Stash is a web port of a native macOS app built with Glaze. It is a client for Instapaper — it
reads, archives, and deletes bookmarks you already have there. It never creates bookmarks and is
not affiliated with or endorsed by Instapaper.

**Stash is single-tenant by design.** There is no sign-up and no shared backend: you deploy your
own instance, connect it to your own Instapaper account, and it serves exactly you. If you want to
use it, fork or clone this repo and deploy it yourself.

> **Status: early.** The spec and work plan are complete; the first piece of real code is the
> extraction probe (below). The PWA itself has not been started.

## Try the extraction probe

Before any of the app exists, you can answer the question it hinges on: does replaying a publisher
session actually get you the full article?

```bash
npm install
npm run probe -- https://www.example.com/some-paywalled-article
```

With a session stored for that host it fetches twice — anonymously and authenticated — and reports
what each attempt got:

```
  anonymous         HTTP 200  raw   412 KB  extracted      847 chars  looks truncated
  with session      HTTP 200  raw   448 KB  extracted   18,455 chars  looks complete
```

[`docs/COOKIE_SETUP.md`](docs/COOKIE_SETUP.md) covers where to get the cookie header.
`--file <path>` runs the same pipeline over a saved HTML file, with no network.

## What it does

- **Front page.** One large randomly-chosen featured article with image, title and excerpt; three
  secondary articles with images below it; a sidebar with two title-only lists — the 5 oldest and
  the 5 newest unread bookmarks. Articles with no recoverable image never occupy one of the four
  image slots, but can still appear in the sidebar.
- **Reading view.** Full article text in a horizontally paginated, e-reader-style multi-column
  layout, with per-article archive and delete actions and sticky typography preferences (font,
  size, line height, column width).
- **Sync.** Archive and delete hit the Instapaper API, not just local state. Bookmarks added
  elsewhere (phone, browser extension) appear on the next refresh.
- **Better text than Instapaper alone.** Instapaper's own extractor gives up on some paywalled or
  script-heavy pages. When it returns nothing usable, Stash re-extracts the article itself — and
  for publishers you subscribe to, it can replay a session you established yourself so the page
  arrives complete.

The product spec is [`docs/DESIGN_SPEC.md`](docs/DESIGN_SPEC.md) and the extraction subsystem is
[`docs/EXTRACTION.md`](docs/EXTRACTION.md); where the implementation deliberately departs from
either, [`WORKPLAN.md`](WORKPLAN.md) records why.

## Architecture

```
┌─────────────────────────┐        ┌──────────────────────────┐       ┌──────────────┐
│  PWA (Vite + React)     │        │  Serverless functions    │       │  Instapaper  │
│                         │ ─────► │  (same deployment)       │ ────► │  Full API    │
│  IndexedDB cache        │        │                          │       └──────────────┘
│  no credentials         │        │  OAuth token from env    │       ┌──────────────┐
└─────────────────────────┘        │  article extraction      │ ────► │  Source URLs │
                                   └──────────────────────────┘       └──────────────┘
```

- **No user accounts.** The Instapaper OAuth token lives in the deployment's environment variables
  and never reaches the browser.
- **The serverless layer is not optional.** Instapaper's API and third-party sites don't send CORS
  headers, so every outbound call is proxied. It is also the only place credentials exist.
- **Cache is per-device**, in IndexedDB: bookmarks, article text, reading preferences. None of it is
  precious — Instapaper is the source of truth and text is re-fetchable — so eviction costs an API
  round-trip, not data.
- **A small KV store** holds the two things that can't live in the browser or in env vars: resolved
  image URLs (expensive to re-derive, worth sharing across devices) and encrypted per-publisher
  session cookies.
- **Access is gated by a passphrase** you set at deploy time. Without it, anyone who finds the URL
  can read and delete your Instapaper queue.

Where each piece of data lives, and why, is tabulated in
[WORKPLAN.md](WORKPLAN.md#where-each-piece-of-data-lives).

Planned stack: Vite + React + TypeScript, deployed to Vercel (static PWA + Node serverless
functions). See [WORKPLAN.md](WORKPLAN.md#architecture-decided) for why, and what changes if you'd
rather use Cloudflare or Netlify.

## Repository layout

```
src/lib/              Extraction core — cookies, truncation, fetch guard, extract
scripts/probe.ts      CLI: does a session change what this publisher serves?
test/                 Unit tests, adversarial where it matters
fixtures/             Saved pages for offline testing
docs/DESIGN_SPEC.md   Product + technical spec (source of truth)
docs/EXTRACTION.md    Full-text extraction, ported from the SanFeedBin method
docs/COOKIE_SETUP.md  How to give Stash a publisher session
WORKPLAN.md           Phased implementation plan, decisions, open questions, risks
.env.example          Every environment variable, documented
```

The PWA, its serverless functions and the rest of the tooling land as the phases in `WORKPLAN.md`
are completed. What's in `src/lib` today is Phase 7a code, written early because it answers the
riskiest product question first.

## Getting started

Nothing to run yet. Once Phase 1 lands, this section will cover prerequisites, the one-time
`npm run connect` token exchange, and the deploy step. `.env.example` already documents every
variable you'll need.

Running your own instance requires Instapaper **Full API** credentials (a consumer key and secret,
with xAuth enabled), which Instapaper issues on request.

## Constraints we hold ourselves to

These come from Instapaper's API terms and are treated as non-negotiable throughout the codebase:

- The account password is used for exactly one token-exchange request, then discarded. Only the
  resulting OAuth token/secret is persisted.
- No bookmark is ever archived or deleted except by an explicit, per-item user click. No bulk
  actions, no automated cleanup.
- Never scrape instapaper.com. Image resolution and text re-extraction only ever fetch a
  bookmark's own original source URL.
- The app never creates bookmarks.
- "Instapaper" is not used as this app's name or logo — Stash describes itself as a client *for*
  Instapaper.

## License

MIT — see [LICENSE](LICENSE).
