# Giving Stash a publisher session

For publishers you subscribe to, Stash can fetch articles as *you* — so the page arrives complete
instead of as a paywall stub. It does that by replaying a session you established yourself, in your
own browser.

On Android, SanFeedBin does this with a sign-in WebView and takes the cookies from it directly. A
browser can't: no page may read another origin's cookies, and no API will ever allow it. So the
copy step is manual. **Once per publisher**, then again whenever that publisher signs you out.

Try it on one site before deciding whether it's worth doing on five. The `probe` script below tells
you within a minute whether it changed anything.

## Copying the header

You need the value of the `Cookie:` **request** header your browser sends. Not the cookie list in
the storage panel — that view drops what the header actually looks like, and misses nothing useful.

### Chrome, Edge, Brave, Arc

1. Sign in to the publisher normally, in a normal tab.
2. Open an article you can read. Press <kbd>F12</kbd> (or <kbd>⌥⌘I</kbd>) for DevTools → **Network**.
3. Reload the page.
4. Click the **first** request in the list — the document request, usually the article URL itself.
5. **Headers** → scroll to **Request Headers** → find `cookie:`.
6. Right-click it → **Copy value**. If your build has no "Copy value", select the value text and copy
   it by hand; it is long, so check you got all of it.

### Firefox

Same path: <kbd>F12</kbd> → **Network** → reload → click the document request → **Headers** →
**Request Headers** → right-click `Cookie` → **Copy Value**.

### Safari

Enable the developer tools first: **Safari → Settings → Advanced → Show features for web
developers**. Then <kbd>⌥⌘I</kbd> → **Network** → reload → click the document request → **Headers**
→ copy the `Cookie` value under Request Headers.

### Not on a phone

iOS Safari has no usable DevTools, and Android's are awkward. Do this on a desktop. Because the
store lives server-side, doing it once there covers every device you read on — which is an
improvement on the Android app, where the store was per-install.

## Storing it

Don't hand-edit a file. Pipe the header in:

```bash
# macOS, straight from the clipboard
pbpaste | npm run session -- add www.ft.com

# Linux
xclip -o -selection clipboard | npm run session -- add www.ft.com

# anywhere: run it, paste, then press Ctrl-D
npm run session -- add www.ft.com
```

Reading from stdin keeps the header out of your shell history. Nothing is echoed back but the
cookie **names**:

```
Stored 4 cookies for www.ft.com in sessions.txt.
FTSession, FTUser, consent, spoor-id
```

`npm run session -- list` shows what's stored, and `remove <host>` forgets one.

The host is what appears in the address bar. A session saved for `ft.com` also covers `www.ft.com`
and `markets.ft.com`; one saved for `www.ft.com` covers only that.

Behind this is `sessions.txt` — one host per line, git-ignored, and the local stand-in for the
encrypted server-side store. You *can* edit it by hand:

```
www.ft.com   FTSession=abc; FTUser=def
```

An older `sessions.json` still works, but JSON is a poor fit for pasted headers: a stray newline,
quote or backslash breaks the whole file with an unhelpful byte offset. The line-based format has
none of those failure modes.

## Trying it

Point the probe at an article you know is paywalled:

```bash
npm run probe -- https://www.ft.com/content/some-article
```

It fetches twice — once anonymously, once with your session — and reports both:

```
www.ft.com /content/some-article
session: 4 cookies — FTSession, FTUser, consent, spoor-id

  anonymous         HTTP 200  raw   412 KB  extracted      847 chars  looks truncated (under 1500 chars)
  with session      HTTP 200  raw   448 KB  extracted   18,455 chars  looks complete

  → The session is doing the work here — 17,608 more characters.
```

That is the whole question answered. The probe tells you which outcome you got:

- **Session much longer than anonymous** — worth doing for this publisher.
- **Anonymous already complete** — this publisher needs no session at all. Don't store one.
- **Anonymous refused, session worked** — the session isn't optional here; the publisher won't
  serve the page to a signed-out reader at all. Common on Belgian and Dutch news sites.
- **Session changed nothing** — either it has expired, or the page builds its body with JavaScript,
  which cookies cannot fix. See [the limits](EXTRACTION.md#what-this-does-not-solve).
- **Refused both ways** — anti-bot protection, not a paywall. See below.

Cookie **values** are never printed, only names. The probe follows the same rule the app does.

## When you get HTTP 403

A 403 on the anonymous attempt is ordinary and often the *expected* result — plenty of publishers
refuse a signed-out fetch outright rather than serving a stub. Store your session and try again;
that is precisely the case this feature exists for.

A 403 **with** a valid session is different. It means the publisher is refusing the request itself,
not the reader — bot protection reacting to a non-browser client. Stash identifies itself honestly
as `Stash/0.1`, and some sites reject anything that isn't a browser.

Sending a browser User-Agent would get past some of these. It is a deliberate choice rather than a
default, because it is the first step from "a reading tool" toward "a circumvention tool", and the
line is worth drawing on purpose — see the posture note at the end of
[`EXTRACTION.md`](EXTRACTION.md#a-note-on-posture). It also would not help against a real challenge
page, which needs a browser to answer it, not a browser's name.

If a publisher refuses both ways, the honest answer for that one is to open it in a browser.

## How often you'll redo this

Once per publisher, then whenever that session dies. In practice that means months for a
subscription site where you ticked "keep me signed in", and sooner if you sign out, clear cookies,
or change password. Stash tells you rather than failing quietly: if extraction succeeds but the
result still looks truncated *and* cookies were sent for that host, the session has almost certainly
expired — you'll get a "session may have expired" prompt with a re-paste action. It never clears the
session on its own; one bad extraction isn't proof.

If this turns out to be the step that stops you using Stash, the fix is a small browser extension
that captures a host's cookies in one click — the real equivalent of the Android WebView flow. It's
scoped in the work plan as Phase 7c and deliberately deferred until we know whether it's needed.

## What Stash stores, and what it doesn't

- Only `name=value` pairs. `Secure`, `HttpOnly`, `Path`, `Expires` and `SameSite` are dropped —
  every target is HTTPS, cookies sit at the root, and expiry is enforced by the publisher anyway.
- Encrypted at rest, in a store separate from the Instapaper token. Rotating one never destroys the
  other; re-acquiring site sessions means walking through every publisher again.
- Values never travel back to the browser. Settings lists which hosts have a session, never what
  it contains.
- Cookies go only to the host they were saved for, by strict RFC 6265 matching, and are **dropped on
  a cross-host redirect** rather than forwarded.

Your session is your subscription. Treat `sessions.json` as you would a password file — it is
git-ignored for that reason, and nothing about it should ever end up in a commit or an issue.
