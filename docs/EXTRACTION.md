# Full-text extraction — porting the SanFeedBin method

Stash's fallback for articles Instapaper fails to extract is ported from **SanFeedBin** (Android,
Kotlin), specified in "Authenticated Full-Text Extraction". That spec is the source of truth for
everything below; this document records what survives the port to a browser-hosted PWA, what
doesn't, and what replaces it.

## The method, in one paragraph

Two HTTP clients, not one. The app's API client carries the service credentials. A second,
**credential-free** client fetches article pages, and the only identity it carries is a cookie jar
backed by an encrypted per-host store. The user fills that store once per publisher by signing in
normally through a WebView; from then on the extractor's requests look like that logged-in user, so
the publisher serves the full body instead of the public excerpt. Readability reduces the page to an
article fragment, and a short chain of post-processors removes the artefacts the feed and the page
introduce. Nothing is site-specific: no per-publisher adapter, no headless browser, no login
automation.

## What ports cleanly

Everything downstream of the fetch, and every gating decision. It is plain logic with direct
JavaScript equivalents:

| SanFeedBin | Stash |
| --- | --- |
| Readability4J | `@mozilla/readability` (same Mozilla algorithm) |
| jsoup | `linkedom` (or `cheerio`) |
| OkHttp + `CookieJar` | `undici` / `fetch` with an explicit `Cookie` header |
| Kotlin `Result` | a single discriminated result type |

Ported as specified:

- **Truncation heuristic** — two ORed signals over plain text: under ~1500 characters, or a sentinel
  phrase ("read more", "continue reading"). Keep the sentinel list short; `[…]` counts only when it
  ends the text. In Stash this decides whether Instapaper's `get_text` output is good enough, which
  is exactly the question SanFeedBin asks of a feed excerpt.
- **The four cleaners** — strip the duplicate title (exact after normalisation, or a substring ≥60%
  of the heading, catching "Title | Site Name"; prune an emptied wrapper); prepend a missing intro
  when >10% of the excerpt's words are absent from the extracted start, with images, iframes and
  headings stripped; remove page furniture by stable signal (link target, marker string) **never by
  publisher name**; re-derive the hero image, preferring the first image inside a `<figure>`, then
  any image ≥600px wide, returning nothing rather than guessing.
- **Render-time cleaning.** Furniture removal runs at render, not extraction, so a new rule fixes
  already-cached articles without a re-sync. Worth keeping — it is why the rule list can grow
  cheaply.
- **Store beside, never over.** Instapaper's text and our extraction are separate fields, with a
  derived accessor (`extracted ?? instapaper`) choosing what to render. A "show original" toggle
  comes free and a bad extraction is never destructive.
- **Politeness.** Serial fetches with a ~250ms delay, an honest app-shaped User-Agent
  (`Stash/1.0 (+repo-url)`), redirects on, short timeouts (10s connect / 15s read).
- **Failure discipline.** Non-2xx, empty body and empty Readability output are ordinary failures,
  not exceptions. Record a short stable tag ("HTTP 403", "Readability returned empty"), capped at
  80 characters — never a stack trace.
- **The expired-session diagnostic.** If extraction succeeds but the result still trips the
  truncation heuristic *and* cookies were sent for that host, the session has almost certainly
  expired. Log it with a clear next step; do not auto-clear the cookies — one bad extraction is not
  proof a session is dead.
- **Retry backoff in code, not in the query** — a week between retries of a failed URL. Putting it
  in the query silently overrides the per-source "Always" override.
- **Single-flight** — a try-lock around the pass; overlapping triggers skip rather than queue.
- **User-initiated extraction bypasses every gate.** An explicit "fetch full content" action is a
  decision, not a hint.
- **RFC 6265 domain matching**, and nothing looser: a cookie saved for host `H` is sent to request
  host `U` only when `U == H` or `U` ends with `.H`. The leading dot is what makes
  `fakenytimes.com` fail to match `nytimes.com` — `endsWith` or `includes` without it is a real
  vulnerability, not a style question. Unit-test it hard: spoofed suffixes, leading dots, case,
  values containing `=`.

## What does not port: capturing the session

**A browser cannot read another origin's cookies.** SanFeedBin's sign-in screen works because
Android's `CookieManager` exposes the WebView's cookie jar to the host app. A PWA has no equivalent
and cannot have one — the same-origin policy is the whole point. An iframe pointed at a publisher
gives us nothing, and `document.cookie` in a bookmarklet cannot see `HttpOnly` cookies, which is
what session cookies almost always are.

So the capture lane needs replacing. Three options, in the order Stash should adopt them:

### 1. No cookies at all (start here)

Run the fetch-and-reduce path with an empty jar. This already beats Instapaper on **soft paywalls** —
pages that serve the full body in the HTML and hide it behind a CSS or JavaScript overlay, which is
a meaningful share of them. Zero setup, zero storage, no credentials anywhere.

This is stage one of SanFeedBin's own build order ("extractor with the jar attached — with an empty
store the jar sends nothing"), and it is independently useful. Ship it before building any capture
mechanism.

### 2. Manual per-host cookie paste (the practical replacement)

In settings: pick a host, paste a `Cookie:` header value, save. The user gets it from their own
browser's devtools (Network tab → any request to the publisher → copy the `Cookie` request header)
after logging in normally.

- Clunkier than a WebView, but the same shape: the user logs in themselves, once per publisher, and
  we only ever hold the resulting `name=value` pairs.
- Setup is desktop-only in practice — devtools on iOS Safari is not a realistic ask. But because
  the store lives server-side, doing it once on a desktop benefits every device. That is an
  improvement on the Android version, where the store was per-install.
- Keep SanFeedBin's deliberate lossiness: only `name=value` survives; `Secure`, `HttpOnly`, `Path`,
  `Expires`, `SameSite` are dropped. Every target is TLS, cookies sit at the root, and expiry is
  enforced server-side — a dead session just falls back to the public text and the user re-pastes.

### 3. A browser extension (optional, later)

A small extension with the `cookies` permission can capture a host's cookies on one click and POST
them to the Stash instance — the closest equivalent to the Android WebView flow, and the only way to
make this pleasant. It is a separate deliverable with its own store review, and should not block
anything. Build it only if the paste step turns out to be the thing that stops you using Stash.

## Where the cookies live

Site cookies are bearer credentials for the user's publisher accounts. Three requirements follow,
and together they are the reason Stash needs a small server-side store despite having no user
accounts:

1. **Never in the browser.** Not IndexedDB, not `localStorage`. They must not be reachable by
   client-side script, which means the client never receives them at all — it only ever sends a host
   and a cookie string in, and reads back the list of hosts that have one.
2. **Updatable at runtime.** Sessions rotate and publishers get added. Environment variables — fine
   for the Instapaper token, which is set once — cannot do this.
3. **Encrypted at rest under our own key**, so the storage provider never holds plaintext session
   cookies. This is the web equivalent of SanFeedBin's `EncryptedPrefsBackend`: AES-GCM with a key
   from `STASH_ENCRYPTION_KEY`, and the same corrupt-blob recovery (delete and recreate rather than
   crash).

And SanFeedBin's rule holds exactly: **keep this store separate from the app's own credentials.**
The Instapaper token lives in env vars; site cookies live in KV. Rotating one must never destroy the
other — re-acquiring site sessions means walking the user through every publisher again.

## What this does not solve

Unchanged from the source spec, and worth stating plainly to avoid wasted effort. The extraction
path parses HTML; it has no JavaScript engine.

- **JavaScript-rendered paywalls.** If the body is fetched or decrypted by client-side script after
  load, the HTML genuinely does not contain it. Shows up as a 200 with a large body and a tiny
  extraction.
- **Anti-bot challenges.** Same root cause — a challenge page needs a browser to answer it.
- **Token-bearer APIs.** Sites authenticating internal content endpoints with OAuth need per-site
  reverse engineering, which is the thing this design exists to avoid.

The workable fallback for all three is opening that article in a browser, not a cleverer extractor.
Worth knowing: within one publishing group, free articles often extract perfectly while premium ones
don't — measure per article, not per domain, before writing a publisher off.

## A note on posture

This design deliberately never pretends to be someone it isn't. It uses an honest app-shaped
User-Agent, fetches serially with a delay, and the only content it unlocks is content the user
already has a paid, logged-in right to read — replayed from a session the user established
themselves, in their own browser, exactly as SanFeedBin has them do it in a WebView. It is not
crawler-UA spoofing and not an archive mirror. Keep it that way: the moment the extractor starts
claiming to be Googlebot, this stops being a reading tool and becomes a circumvention tool.
