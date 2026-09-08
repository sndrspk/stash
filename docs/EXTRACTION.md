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
- **Standfirst recovery** — a fifth, added after a real page showed why the intro cleaner above is
  not enough. Readability returns the container with the highest density of paragraphs, and a
  standfirst is routinely a single `<h2>` in an `<hgroup>` beside the body — headline, standfirst,
  byline, date — which scores nothing and is dropped. Recovered from the source page by marker
  vocabulary (`standfirst`, `intro`, `lede`, `lead`, `chapeau`, `perex`, `dek`) in `data-testid`,
  `class`, `id` or `itemprop`, matched as **whole tokens** after splitting separators and camelCase:
  substring matching would key on an accident of spelling, since Dutch `ontdek-meer` contains `dek`.
  Guarded as prose — 40–1500 characters, link density ≤25% — and skipped when the extraction already
  contains it, because printing the opening paragraph twice is worse than dropping it and much
  harder to notice. Runs **before** `Readability.parse`, which mutates the document it is given.
- **Render-time cleaning.** Furniture removal runs at render, not extraction, so a new rule fixes
  already-cached articles without a re-sync. Worth keeping — it is why the rule list can grow
  cheaply.
- **Store beside, never over.** Instapaper's text and our extraction are separate fields, with a
  derived accessor (`extracted ?? instapaper`) choosing what to render. A "show original" toggle
  comes free and a bad extraction is never destructive.
- **Politeness.** Serial fetches with a ~250ms delay, an honest app-shaped User-Agent
  (`Stash/0.1 (+repo)`, overridable per deployment — see the posture note), redirects on, short timeouts (10s connect / 15s read).
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
- **Anti-bot challenges.** Same root cause — a challenge page needs a browser to answer it. A
  stored session does not help even when it contains the challenge's own clearance cookie:
  those are issued against the address *and* the User-Agent that earned them, so replaying one
  from anywhere else presents a token that does not match the request carrying it. A deployment
  can therefore never satisfy a challenge the reader's browser passed, whatever is in the store.
  This was reached the slow way — a 403 that survived a browser User-Agent, and then survived
  being run from the reader's own laptop, which is what ruled out both the User-Agent and the
  datacentre address in turn.
- **Token-bearer APIs.** Sites authenticating internal content endpoints with OAuth need per-site
  reverse engineering, which is the thing this design exists to avoid.

The workable fallback for all three is opening that article in a browser, not a cleverer extractor.
Worth knowing: within one publishing group, free articles often extract perfectly while premium ones
don't — measure per article, not per domain, before writing a publisher off.

### Telling the ceiling from a missed container

The first case above — "a 200 with a large body and a tiny extraction" — is the signature of a
JavaScript-rendered page, and it is also the signature of a page whose article *is* in the HTML in a
form Readability does not read. Readability scores markup; it has no opinion about a `<script>`. So
a body sitting in a JSON-LD `articleBody` or a framework's hydration payload is invisible to it and
present in the file, and the two cases are indistinguishable from the outside while differing
completely in what can be done about them.

Count rather than guess:

```sh
npm run probe -- <url> --raw page.html
```

That fetches once, replaying a stored session if there is one, writes the bytes exactly as sent, and
reports what is in them: `<p>` elements, how much of the page is inline script, whether any
`application/ld+json` block carries an `articleBody` and how long it is, and whether a recognised
hydration payload is there. `--file page.html` prints the same census for a page saved from a
browser, which is the path for an article the deployment cannot reach at all.

Then the number that actually decides it — how much **visible prose** the document holds, script and
style stripped, against how much the extractor found, broken down by container:

```
    401 chars of visible text in the document (extractor found 381)
    fattest paragraph containers:
        379 chars in 3 <p>  article#main.Article_body__x9.wrapper
         16 chars in 2 <p>  nav
```

Per container rather than as a total, because a total cannot tell one long article from forty
teasers and those look identical until you see the shape. An element with at least two direct `<p>`
children is what Readability itself scores, so the top row names the container it *should* have
picked — with enough of a selector to find it in the file by eye.

Reading the result:

- **An `articleBody` present but unused** is a fixable gap and a publisher-agnostic one: it is a
  schema.org field, not a site's markup.
- **A fat top container and a thin extraction** means the article was sent and Readability scored
  the wrong element. Also fixable, and the selector says where to look.
- **A thin top container** — a few hundred characters, matching the extraction — is the ceiling.
  The article genuinely was not in the response, and no extractor reaches it.

Beware the intermediate reading that looks like the third and is not: *most of the page is markup*
proves nothing on its own. Navigation, menus and footers are markup too, so a page can be 80% markup
and hold no article at all. Only the prose count separates them.

### One more command before calling it the ceiling

The census looks for the signals it knows: JSON-LD, two named hydration shapes, paragraph markup. A
page can still carry its body in some other blob, and on a real page tens of kilobytes of inline
script routinely remain unaccounted for. **Absence of the signals you thought to look for is not
absence of the thing.**

Open the article in a browser, take four or five distinctive words from the *middle* of it, and
search the saved file:

```sh
grep -c -i "vier of vijf woorden" page.html
```

`0` closes it: the text was never sent, and the fallback is opening the article in a browser — which
is what the origin link in the reading bar is for. Anything above `0` means it is in there in a shape
worth finding, and the census should learn to see it.

This is what settled knack.be. The census reported no `articleBody`, no hydration payload, 3,368
characters of visible text, and a paywall block as the fattest paragraph container — and the grep
returned `0`, which turned a strong inference into an answer. The session was working throughout: it
buys the signed-in shell rather than the login page, and the body arrives by script afterwards.

## A note on posture

This design deliberately never pretends to be someone it isn't. It uses an honest app-shaped
User-Agent, fetches serially with a delay, and the only content it unlocks is content the user
already has a paid, logged-in right to read — replayed from a session the user established
themselves, in their own browser, exactly as SanFeedBin has them do it in a WebView. It is not
crawler-UA spoofing and not an archive mirror. Keep it that way: the moment the extractor starts
claiming to be Googlebot, this stops being a reading tool and becomes a circumvention tool.

### What use changed, and what it did not

`Stash/0.1 (+repo)` is refused with **HTTP 403 by most paywalled publishers**, before any cookie is
read. Bot protection rejects on User-Agent shape alone, so a reader with a valid paid session is
turned away for how the request introduces itself rather than for who is making it.

`STASH_USER_AGENT` overrides the default, per deployment, and is unset in the repository. The
distinction it rests on is worth stating plainly rather than eliding:

- **Claiming to be Googlebot stays out**, and the sentence above stands. Publishers serve crawlers
  text they deliberately withhold from readers, so a crawler UA takes something that was never on
  offer. That is circumvention whatever the intent behind it.
- **Claiming to be a browser is a different act.** The request is one person's, carries their own
  credentials, and asks for an article they pay for — which is what a browser request is. It is
  also, unavoidably, defeating a control the publisher chose to deploy. Both of those are true and
  the second does not disappear because the first is.

It is opt-in because the deployment belongs to one reader and the choice is theirs to make about
their own subscriptions. Making it the default would decide it on behalf of everyone who forks
this, including people who never considered the question — which changes what the project is,
rather than what one deployment does. Nothing else moves: still serial, still delayed, still only
articles the reader already pays for.
