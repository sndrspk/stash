# Giving Stash a publisher session

Some publishers won't serve an article to a signed-out reader. Stash can fetch those as **you**, by
replaying a session you created yourself in your own browser — so a page that would arrive as a
paywall stub, or not at all, arrives complete.

This is the whole procedure. It takes about two minutes per publisher.

**You need:** an account at the publisher (a paid one, if the articles you want are paid), and a
desktop browser. This is not possible on a phone — see [Why not on a phone](#why-not-on-a-phone).

**In short:** sign in → copy one line from your browser's developer tools → paste it into
**Settings → Publisher sessions** in the app → read one of that publisher's articles.

Everything below describes both ways of doing step 3: the app's settings screen, which is what a
deployment uses, and `npm run session -- add`, which is the same thing on your own machine for the
probe. Steps 1 and 2 — the part that takes the two minutes — are identical either way.

---

## Step 1 — Sign in to the publisher

In an ordinary browser tab, sign in to the publisher the way you always do. Email link, SSO,
two-factor — all of it is fine, because you are doing it yourself in a real browser. Stash is never
involved in the login.

Tick "keep me signed in" or "remember me" if offered. It makes the session last longer.

Then open an article you can actually read. Stay on that page for the next step.

## Step 2 — Copy the cookie header

You want the value of the **`cookie` request header** — the one line your browser sends to identify
you. It is long: often several hundred characters.

> **Not** the Application → Cookies panel. That table shows the same cookies in a different shape,
> and copying from it is more fiddly. (Stash will accept a paste from there if you do — but the
> Network tab is the easy path.)

### Chrome, Edge, Brave, Arc

1. Press <kbd>F12</kbd> — or <kbd>⌥</kbd><kbd>⌘</kbd><kbd>I</kbd> on a Mac — to open DevTools.
2. Click the **Network** tab.
3. Reload the page (<kbd>⌘</kbd><kbd>R</kbd> / <kbd>Ctrl</kbd><kbd>R</kbd>). The list fills up.
4. Click the **first** entry in the list. It is the page itself — its name matches the article URL,
   and its Type is `document`.
5. In the panel that opens, stay on **Headers** and scroll down to **Request Headers**.
6. Find the row starting `cookie:`.
7. Right-click it → **Copy value**.

If your build has no "Copy value", click **view source** next to Request Headers, then select the
whole `cookie:` line and copy it. Include everything up to the end of the line — the value does not
wrap onto the next one, however it looks on screen.

### Firefox

1. <kbd>F12</kbd> → **Network** tab.
2. Reload the page.
3. Click the first entry (the document request).
4. **Headers** → **Request Headers** → right-click `Cookie` → **Copy Value**.

### Safari

Developer tools are hidden by default:

1. **Safari → Settings → Advanced →** tick **Show features for web developers**.
2. <kbd>⌥</kbd><kbd>⌘</kbd><kbd>I</kbd> → **Network** tab.
3. Reload the page.
4. Click the first entry → **Headers** → under **Request Headers**, select the `Cookie` value and
   copy it.

## Step 3 — Give it to Stash

### In the app

Open **Settings → Publisher sessions**, put the publisher in the first box — `www.ft.com`, or the
whole article URL, which is easier since it is already on your clipboard — paste the header into the
second, and press **Save session**.

It answers with the cookie *names* it stored and nothing else:

> Stored 26 cookies for www.nieuwsblad.be.

The list below then shows that publisher, its cookie names, and how long ago you pasted it. **Sign
out** forgets one. There is no way to read a value back out, from the screen or from the API — the
server does not have an endpoint that returns one.

If the screen says no key-value store is attached, see
[Where they live once Stash is deployed](#where-they-live-once-stash-is-deployed).

### On the command line

For `npm run probe`, which reads a local file rather than the deployment's store. Three ways — they
do the same thing.

**Paste at a prompt** (simplest):

```bash
npm run session -- add www.nieuwsblad.be
```

It waits, you paste, you press **Enter**. That's it — no Ctrl-D.

**From the clipboard**, if you haven't copied anything else since Step 2:

```bash
pbpaste | npm run session -- add www.nieuwsblad.be                  # macOS
xclip -o -selection clipboard | npm run session -- add www.nieuwsblad.be   # Linux
```

**From a file**, if pasting several hundred characters into a terminal misbehaves:

```bash
npm run session -- add www.nieuwsblad.be --from header.txt
```

You can also pass the article URL instead of the host — `npm run session -- add
https://www.nieuwsblad.be/cnt/whatever` works, and takes the host from it.

The header is never accepted as a command-line argument, so it stays out of your shell history.

On success you get back the cookie **names** and nothing else:

```
Stored 26 cookies for www.nieuwsblad.be in sessions.txt.
_pcid, didomi_token, cf_clearance, auth_coral_sso_token, ...
```

### Which host to use

Use the host as it appears in the address bar — `www.nieuwsblad.be`, not `nieuwsblad.be`, if that's
what the URL says.

A session saved for `nieuwsblad.be` is also sent to `www.nieuwsblad.be` and `sport.nieuwsblad.be`.
One saved for `www.nieuwsblad.be` is sent only to that exact host. When in doubt, use what the
address bar shows: it is the host your cookies actually came from.

## Step 4 — Check that it worked

Point the probe at an article from that publisher — ideally one you know is paywalled:

```bash
npm run probe -- https://www.nieuwsblad.be/cnt/some-article
```

It fetches twice, once anonymously and once with your session, and compares:

```
www.nieuwsblad.be /cnt/some-article
session: 26 cookies — _pcid, didomi_token, cf_clearance, ...

  anonymous         failed  HTTP 403
  with session      HTTP 200  raw  636 KB  extracted    7,024 chars  looks complete

  → The session is not optional here — www.nieuwsblad.be refuses anonymous fetches
    outright, and serves the article once you're signed in.
```

The last line tells you which of these you got:

| What you see | What it means |
| --- | --- |
| Session much longer than anonymous | Working. This publisher is worth a session. |
| Anonymous refused, session worked | Working, and the session is essential — no stub is served at all. |
| Anonymous already complete | This publisher needs no session. Remove it; don't store what you don't need. |
| Session changed nothing | Expired session, or a page that builds its body with JavaScript. |
| Refused both ways | Anti-bot protection rather than a paywall. See [Troubleshooting](#troubleshooting). |

---

## Where it is stored

In `sessions.txt` in the repo root — one host per line:

```
www.nieuwsblad.be nb_session=abc; consent=1; cf_clearance=...
www.ft.com        FTSession=def; FTUser=ghi
```

Managing what's there:

```bash
npm run session -- list                      # hosts and cookie names, never values
npm run session -- remove www.nieuwsblad.be  # forget one publisher
```

You can edit `sessions.txt` by hand — host, a space, the header — but there's rarely a reason to.

**Treat this file as you would a password file.** These are live credentials: anyone who has it can
read as you at those publishers. It is git-ignored, and while Stash is only a probe it sits in plain
text on your own machine. If that bothers you, remove a session when you are done testing with it.

### No, it is not in the public repo

The repository contains code. Your data is not in it and cannot be:

| | Where it lives | In GitHub? |
| --- | --- | --- |
| Publisher session cookies | `sessions.txt`, then the KV store below | **No** — git-ignored, then server-side |
| Instapaper token, passphrase, encryption key | environment variables on your deployment | **No** |

Someone who forks this repo gets the code and nothing of yours. That is the ordinary shape for an
open-source app: public code, private configuration. You can confirm it yourself —
`git check-ignore -v sessions.txt` will name the rule that hides it, and `git status` never offers
to commit it.

### Where they live once Stash is deployed

In a **key-value store** attached to your own deployment.

A key-value store — "KV" — is a very small database that is really just a dictionary: you give it a
key, it gives you back a value. No tables, no schema, no SQL. What it holds is exactly this:

```
"www.ft.com"        →  "FTSession=abc; FTUser=def"
"www.nieuwsblad.be" →  "nb_session=...; consent=1"
```

Which is to say: **`sessions.txt`, but hosted.** Same shape, same contents, somewhere your deployed
app can reach it. In practice that is Vercel KV or Cloudflare KV depending on where you deploy; both
have free tiers vastly larger than a few dozen cookie strings need.

It is not Postgres or Supabase on purpose. There is one user and one access pattern — *give me the
cookies for this host*. A relational database would be a two-column table that is never joined,
sorted or queried: a dictionary with extra steps and a schema to maintain. But it cannot be an
environment variable either, the way the Instapaper token is, because sessions get added and
replaced while the app is running. A KV store is the smallest thing that does the job.

There, the values are encrypted under `STASH_ENCRYPTION_KEY` before being written, so the hosting
provider stores ciphertext, and they are never sent to the browser — the page asks your deployment
for an article, and the server-side function attaches the cookies.

**Setting it up.** Attach a KV store to the project; most hosts then inject the two variables the app
looks for (`KV_REST_API_URL` and `KV_REST_API_TOKEN`, or Upstash's `UPSTASH_REDIS_REST_URL` /
`_TOKEN`). Then set `STASH_ENCRYPTION_KEY` to 32 random bytes — `openssl rand -base64 32`. Both, or
neither: a store with no key is refused rather than filled with plaintext credentials, and no store
at all is a perfectly good deployment that still extracts articles anonymously.

**Rotating `STASH_ENCRYPTION_KEY` orphans every stored session.** The old blobs cannot be read with a
new key, so they are cleared on the next read and the settings screen names the hosts that went. You
paste them again. It does *not* touch the Instapaper token, which is a separate environment variable
and is not in the store at all — that separation is deliberate, because re-acquiring site sessions
means walking through every publisher and re-authorising Instapaper does not.

### One session per publisher, not per device

Because that store lives with your deployment rather than on a device, **you do this once per
publisher and every device benefits.** Add a session from whichever desktop is handy and your phone,
tablet and other laptops all get full articles from then on.

You still need a desktop to *capture* a session, since iOS Safari has no usable developer tools. But
that is once per publisher, not once per publisher per device — which is better than the Android app
this method came from, where the store was per-install.

---

## How often you'll redo this

Once per publisher, then again whenever that session dies. For a subscription site where you ticked
"keep me signed in", that's usually months. Sooner if you sign out, clear cookies, or change your
password.

**Cloudflare sites are the exception.** If `npm run session -- list` shows `cf_clearance` or
`__cf_bm` for a host, expect to redo it more often. Cloudflare ties `cf_clearance` to the browser
and IP address that earned it, which Stash doesn't reproduce, and `__cf_bm` expires within the hour.
Such a session can work for a while and then stop for reasons that have nothing to do with your
login. It's the first thing to suspect when one publisher starts failing while the others are fine.

Stash tells you rather than failing quietly: if a fetch succeeds but the text still looks truncated
*and* cookies were sent for that host, the reading view says "the session for … may have expired",
with a link to the sessions screen. It never clears a session by itself — one bad article isn't
proof, and the same symptom is produced by a page that builds its body with JavaScript, which no
cookie can fix.

---

## Troubleshooting

**`Nothing to store — the input was empty.`**
If you piped from the clipboard, it no longer holds the header; copying anything else replaces it.
Re-copy from Step 2, or use the interactive prompt, which doesn't depend on the clipboard.

**`That doesn't look like a Cookie: header — stdin held a URL.`** (or JSON, or *N* characters)
Something other than the header was pasted. Go back to Step 2 and make sure you're in the **Network**
tab, on the **first** request, under **Request Headers** — not Response Headers, and not the
Application → Cookies panel.

**The command seems to hang after pasting.**
Press **Enter**. It reads one line and stops there; it is not waiting for Ctrl-D.

**`HTTP 403` on the anonymous attempt.**
Normal, and often the point. Plenty of publishers refuse signed-out fetches outright. If the "with
session" line succeeded, everything is working.

**`HTTP 403` both ways.**
The publisher is refusing the *request*, not the reader — bot protection reacting to a non-browser
client. Stash identifies itself honestly as `Stash/0.1`, and some sites reject anything that isn't a
browser. A real challenge page needs a browser to answer it, so no cookie will help. For that
publisher, open the article in a browser. (See the posture note in
[`docs/EXTRACTION.md`](docs/EXTRACTION.md#a-note-on-posture) for why Stash doesn't simply claim to be
a browser.)

**`with session` succeeded but the text is short or looks truncated.**
Either the session has expired — re-do Steps 1–3 — or the page builds its body with JavaScript after
loading, which cookies cannot fix. The
[limits](docs/EXTRACTION.md#what-this-does-not-solve) cover which is which.

**`"..." is not a hostname.`**
Pass a plain host (`www.ft.com`) or a full URL (`https://www.ft.com/content/x`). Anything else is
rejected on purpose: a session stored under a mistyped key would silently never be used.

**A warning about `sessions.json`.**
An older format from before this repo used `sessions.txt`. The warning is harmless; once your
sessions are stored in `sessions.txt`, delete `sessions.json`.

---

## Why not on a phone

iOS Safari has no usable developer tools, and Android's are awkward. Do this on a desktop.

That's less of a limitation than it sounds: the sessions live server-side once Stash is deployed, so
setting a publisher up once on a desktop covers every device you read on afterwards.

---

## What Stash keeps, and what it doesn't

- **Only `name=value` pairs.** `Secure`, `HttpOnly`, `Path`, `Expires` and `SameSite` are discarded.
  Every publisher is HTTPS, the cookies sit at the root, and expiry is enforced by the publisher
  anyway.
- **Values are never displayed.** Every command prints cookie names only, and so does the settings
  screen: it lists which publishers have a session and what the cookies are called, never what they
  contain. This is enforced by the API rather than by the page — the endpoint that lists sessions
  cannot return a value, and the one accessor that can is used by the extractor alone.
- **Cookies go only to the host they were saved for**, by strict RFC 6265 matching, and are dropped
  on a redirect to another host rather than forwarded.
- **Nothing is sent anywhere but the publisher itself.** Your session is used for one thing: fetching
  articles you already have the right to read.
- **Kept apart from the Instapaper credentials.** Rotating one never destroys the other — otherwise
  re-authorising Stash would mean walking through every publisher again.
