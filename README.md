# Stash

A read-it-later PWA for Instapaper, with a newspaper-style front page instead of a plain list.

Stash is a web port of a native macOS app built with Glaze. It is a client for Instapaper — it
reads, archives, and deletes bookmarks you already have there. It never creates bookmarks and is
not affiliated with or endorsed by Instapaper.

**Stash is single-tenant by design.** There is no sign-up and no shared backend: you deploy your
own instance, connect it to your own Instapaper account, and it serves exactly you. If you want to
use it, fork or clone this repo and deploy it yourself.

> **Status: in progress.** The gate, the data layer, image resolution, the front page and the
> reading view are built. What remains is the extraction fallback (Phase 7), offline polish
> (Phase 8) and shipping (Phase 9). [`WORKPLAN.md`](WORKPLAN.md) is the running record.

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

[`SESSIONS.md`](SESSIONS.md) covers where to get the cookie header.
`--file <path>` runs the same pipeline over a saved HTML file, with no network.

## What it does

- **Front page.** One large randomly-chosen featured article with image, title and excerpt; three
  secondary articles with images below it; a sidebar with two title-only lists — the 5 oldest and
  the 5 newest unread bookmarks. Articles with no recoverable image never occupy one of the four
  image slots, but can still appear in the sidebar.
- **Reading view.** Full article text, paged or scrolling. Paged is an e-reader-style multi-column
  layout you move through sideways; scrolling is the ordinary web one, and is the default on a
  phone. Per-article archive and delete, sticky typography preferences (font, size, line height,
  column width), and a choice of paper — beige, white, blue, lilac or mustard — which the whole app
  is printed on.
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
index.html            App entry; theme-color, iOS install metadata, font preload
src/main.tsx          React root; src/App.tsx wraps the router with the paper theme
src/router.tsx        Routes: / · /read/:bookmarkId · /settings · /unlock
src/AppLayout.tsx     The shell; the reading view opts out of it
src/routes/           One component per route
src/components/       Shared UI
src/hooks/            Reusable behaviour: the column layout, the snap, install and pull
src/styles/           Theme tokens (light/dark) and the self-hosted @font-face rules
src/lib/              Extraction core, IndexedDB, image resolution, column arithmetic
api/                  Serverless functions (one origin with the app, via Vercel)
public/fonts/         The four reading faces, self-hosted; see its LICENSE.md
public/icons/         PWA icons, generated by scripts/icons.ts
scripts/probe.ts      CLI: does a session change what this publisher serves?
scripts/fonts.ts      Refetches the fonts; scripts/icons.ts redraws the icons
test/                 Unit tests, adversarial where it matters
fixtures/             Saved pages for offline testing
SESSIONS.md           How to give Stash a publisher session, step by step
docs/DESIGN_SPEC.md   Product + technical spec (source of truth)
docs/EXTRACTION.md    Full-text extraction, ported from the SanFeedBin method
docs/VERCEL.md        Why vercel.json says what it says
WORKPLAN.md           Phased implementation plan, decisions, open questions, risks
.env.example          Every environment variable, documented
```

Some of what's in `src/lib` is Phase 7a extraction code, written early because it answers the
riskiest product question first — it is not wired into the app yet.

## Getting started

Node 20.19+ or 22.13+ (what Vite and ESLint require; `engines` enforces it).

```sh
npm install
npm run dev      # Vite alone — fast, but /api 404s
npm run check    # lint, format, typecheck, tests — what CI runs
npm run build    # production PWA into dist/
```

For anything touching `/api`, use `vercel dev` instead of `npm run dev`: it serves the app and the
functions on one origin, the way production does. It needs the Vercel CLI (`npm i -g vercel`) and a
logged-in account.

### Connecting an Instapaper account

Running your own instance requires Instapaper **Full API** credentials — a consumer key and secret,
with xAuth enabled — which Instapaper issues on request. `.env.example` documents every variable.

```sh
cp .env.example .env
npm run connect
```

`connect` prompts for your Instapaper email and password, exchanges them once for an OAuth token,
prints it, and exits. The password is never written to disk, never logged, and never reaches the
deployed app — it exists only inside that one process, on your machine, for the length of one
request. Paste the two token values it prints into `.env` locally and into your host's environment
variables in production.

There is deliberately no way to do this from the deployed app. It has no code path that writes
credentials, which is why there is no credential store to leak.

If `connect` returns 401, the likeliest cause by some distance is that xAuth is not enabled on your
consumer key. It is granted per application, separately from Full API access, and it fails nowhere
else. It is almost certainly not the request signing — that is verified against RFC 5849's own
worked example by `npm test`.

## Deploying your own

About fifteen minutes, most of it waiting for Instapaper to issue API credentials. The result is a
private URL only you can get past.

### 1. Get the credentials

Ask Instapaper for **Full API** access with **xAuth** enabled. Then, on your own machine:

```sh
git clone https://github.com/sndrspk/stash && cd stash
npm install
cp .env.example .env          # paste the consumer key and secret in
npm run connect               # prompts for your Instapaper login, prints a token
```

Paste the two token values `connect` prints into `.env`. Your password is never stored anywhere and
never reaches the deployed app.

### 2. Choose a passphrase

The deployment URL is public and the account behind it can be deleted from, so a single passphrase
gates every function. **Generate it; do not choose it.**

```sh
openssl rand -base64 24       # STASH_PASSPHRASE
```

### 3. Deploy

```sh
npm i -g vercel
vercel                        # links the project and deploys a preview
```

Then set the environment variables on the project — five required, listed in
[`docs/VERCEL.md`](docs/VERCEL.md) with what each one's absence looks like — and **scope them to
Production, not Preview**. Every branch gets a preview URL, and a preview carrying live credentials
is a second public door to the same Instapaper account.

Vercel attaches the environment at deploy time, so redeploy after adding them: `vercel --prod`.

Open the URL, enter your passphrase, press Refresh. If something is wrong, `/settings` names which
variable rather than making you guess.

### 4. Optional: publisher sessions

Only if you subscribe to publishers whose articles arrive as stubs. Attach a KV store to the project
and set `STASH_ENCRYPTION_KEY` (`openssl rand -base64 32`), then follow
[`SESSIONS.md`](SESSIONS.md). Without it, extraction still runs anonymously, which already handles a
good share of soft paywalls.

### Before you deploy

```sh
npm run check:deploy
```

Lint, format, typecheck, tests, a production build, and a check that **no secret's value appears in
`dist/`**. That last one matters more than it sounds: anything named `VITE_*` is inlined into the
client bundle by design, and `import.meta.env` looks close enough to `process.env` that reaching for
the wrong one is a natural mistake — and a silent one, because the app works perfectly afterwards
with the token sitting in a file anyone can read. Run it with your `.env` present, or the value
search has nothing to search for and says so.

### What it costs

Vercel's Hobby tier is free and ample for one reader; note it is **non-commercial use only**, which
is fine for this. A KV store's free tier is vastly larger than a few dozen cookie strings need.
There is no database, no scheduled job, and nothing that runs when you are not reading.

## Constraints we hold ourselves to

These come from Instapaper's API terms and are treated as non-negotiable throughout the codebase.
Re-read against the code at the end of Phase 9; the five Instapaper endpoints this app has ever
called are `account/verify_credentials`, `bookmarks/list`, `bookmarks/get_text`, `bookmarks/archive`
and `bookmarks/delete`.

- The account password is used for exactly one token-exchange request, then discarded. Only the
  resulting OAuth token/secret is persisted.
- No bookmark is ever archived or deleted except by an explicit, per-item user click. No bulk
  actions, no automated cleanup. **The offline queue does not weaken this**, and it was re-checked
  against it: the queue holds one intent per article, keyed by bookmark id, so it can only ever
  replay a click that happened — never originate one, never coalesce two, never fan one out. It
  drains serially, one call per article, which is the same shape a reader clicking would produce.
  There is no batch endpoint anywhere in this codebase, and `parseBookmarkId` refuses an array
  where a number belongs rather than looping over it.
- Never scrape instapaper.com. Image resolution and text re-extraction only ever fetch a
  bookmark's own original source URL.
- The app never creates bookmarks.
- "Instapaper" is not used as this app's name or logo — Stash describes itself as a client *for*
  Instapaper.

### Article text belongs to whoever wrote it

The constraints above come from Instapaper. This one comes from the publishers whose articles pass
through Stash, and it is worth stating because the answer differs sharply between two things that
look similar.

**Caching an article for the person who saved it is reading.** It is what Instapaper's own apps,
every read-it-later service and every browser reader mode do. **Committing that same article to a
public repository is republishing it**, because a copy then goes to everyone who clones. Three
decisions keep Stash on the first side of that line, and they are load-bearing rather than
incidental:

- **Single-tenant is doing real work here.** One deployment serves one person, so Stash never shows
  one reader's cached article text to anybody else. A shared, server-side article cache would be a
  genuinely different question — the architecture forecloses it rather than answering it.
- **Cached text never leaves the device.** It lives in IndexedDB, per device, and is purged seven
  days after an article is archived or deleted. Nothing is uploaded. The only server-side cache is
  resolved `og:image` URLs, which are addresses rather than content.
- **Fixtures are the exception, and are treated as one.** They are the one place article text would
  be redistributed, so `npm run capture` keeps structure and discards content: every tag,
  attribute, image dimension and character count survives, and every word is replaced. See
  [`fixtures/MANIFEST.md`](fixtures/MANIFEST.md).

Phase 7's extraction fallback is the only path that fetches from a publisher directly rather than
through Instapaper, so it fetches **like a reader, not a crawler**: one named article that you
already saved, an honest `Stash/0.1` User-Agent rather than a disguised one, bounded concurrency
with a per-host delay, and session cookies replayed only for publishers you subscribe to.

None of this is legal advice. It is the reasoning the design actually rests on, written down so that
nobody forking this has to reconstruct it.

## License

MIT — see [LICENSE](LICENSE).
