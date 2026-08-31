# Stash

A read-it-later PWA for Instapaper, with a newspaper-style front page instead of a plain list.

Stash is a web port of a native macOS app built with Glaze. It is a client for Instapaper — it
reads, archives, and deletes bookmarks you already have there. It never creates bookmarks and is
not affiliated with or endorsed by Instapaper.

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

The full product and technical spec lives in [`docs/DESIGN_SPEC.md`](docs/DESIGN_SPEC.md).

## Planned stack

| Layer | Choice |
| --- | --- |
| App | Vite + React + TypeScript, installable PWA |
| Backend | Supabase — Postgres (RLS), Auth, Edge Functions (Deno) |
| Instapaper access | OAuth 1.0a xAuth, performed **server-side** in an Edge Function |
| Cache | Supabase tables (cross-device) with an IndexedDB layer on top for offline reads |

Everything that talks to Instapaper or to third-party sites goes through an Edge Function: browsers
cannot call those origins directly (no CORS), and the Instapaper token must never reach the client.

## Repository layout

```
docs/DESIGN_SPEC.md   Product + technical spec (source of truth)
WORKPLAN.md           Phased implementation plan, open questions, risks
LICENSE               MIT
```

Application code, migrations and Edge Functions land as the phases in `WORKPLAN.md` are completed.

## Getting started

Nothing to run yet. Once Phase 1 lands, this section will cover prerequisites (Node, Supabase CLI),
the environment variables required, and the local dev commands.

Building Stash against a real account requires Instapaper **Full API** credentials (a consumer key
and secret), which Instapaper issues on request. See [Open questions](WORKPLAN.md#open-questions) —
this is the one dependency that is not in our hands.

## Constraints we hold ourselves to

These come from Instapaper's API terms and are treated as non-negotiable throughout the codebase:

- The account password is used for exactly one token-exchange request, then discarded. Only the
  resulting OAuth token/secret is persisted.
- No bookmark is ever archived or deleted except by an explicit, per-item user click. No bulk
  actions, no automated cleanup.
- Never scrape instapaper.com. Image resolution only ever fetches a bookmark's own original source
  URL.
- The app never creates bookmarks.
- "Instapaper" is not used as this app's name or logo — Stash describes itself as a client *for*
  Instapaper.

## License

MIT — see [LICENSE](LICENSE).
