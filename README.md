# Stash

A read-it-later PWA for Instapaper, with a newspaper-style front page instead of a plain list.

Stash is a web port of a native macOS app built with Glaze. It is a client for Instapaper — it
reads, archives, and deletes bookmarks you already have there. It never creates bookmarks and is
not affiliated with or endorsed by Instapaper.

**Stash is single-tenant by design.** There is no sign-up and no shared backend: you deploy your
own instance, connect it to your own Instapaper account, and it serves exactly you. If you want to
use it, fork or clone this repo and deploy it yourself.

> **Status: pre-implementation.** This repository currently contains the design spec and the
> work plan only. No application code has been written yet.

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
  script-heavy pages. When it returns nothing usable, Stash re-extracts the article itself.

The full product and technical spec lives in [`docs/DESIGN_SPEC.md`](docs/DESIGN_SPEC.md); where
the implementation deliberately departs from it, [`WORKPLAN.md`](WORKPLAN.md) records why.

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

- **No database and no user accounts.** The Instapaper OAuth token lives in the deployment's
  environment variables and never reaches the browser.
- **The serverless layer is not optional.** Instapaper's API and third-party sites don't send CORS
  headers, so every outbound call is proxied. It is also the only place the token exists.
- **Cache is per-device**, in IndexedDB. A second device re-syncs rather than sharing state — the
  cost of having no backend, and a fair trade for a personal app.
- **Access is gated by a passphrase** you set at deploy time. Without it, anyone who finds the URL
  can read and delete your Instapaper queue.

Planned stack: Vite + React + TypeScript, deployed to Vercel (static PWA + Node serverless
functions). See [WORKPLAN.md](WORKPLAN.md#architecture-decided) for why, and what changes if you'd
rather use Cloudflare or Netlify.

## Repository layout

```
docs/DESIGN_SPEC.md   Product + technical spec (source of truth)
WORKPLAN.md           Phased implementation plan, decisions, open questions, risks
LICENSE               MIT
```

Application code, functions and tooling land as the phases in `WORKPLAN.md` are completed.

## Getting started

Nothing to run yet. Once Phase 1 lands, this section will cover prerequisites, the one-time
`npm run connect` token exchange, the environment variables to set, and the deploy step.

Running Stash against a real account requires Instapaper **Full API** credentials (a consumer key
and secret), which Instapaper issues on request. See
[Open questions](WORKPLAN.md#open-questions-and-blockers) — this is the one dependency that is not
in our hands.

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
