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

## Trying it before you commit

Create `sessions.json` in the repo root — it is git-ignored, and in the real app this becomes the
encrypted server-side store:

```json
{
  "www.ft.com": "PASTE_THE_COOKIE_HEADER_HERE"
}
```

The key is the **host**, exactly as it appears in the address bar. A cookie saved for `ft.com`
also covers `www.ft.com` and `markets.ft.com`; one saved for `www.ft.com` covers only that.

Then point the probe at an article that you know is paywalled:

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

That is the whole question answered. Three outcomes:

- **Session much longer than anonymous** — worth doing for this publisher.
- **Anonymous already complete** — this publisher needs no session at all. Don't store one.
- **Session changed nothing** — either it has expired, or the page builds its body with JavaScript,
  which cookies cannot fix. See [the limits](EXTRACTION.md#what-this-does-not-solve).

Cookie **values** are never printed, only names. The probe follows the same rule the app does.

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
