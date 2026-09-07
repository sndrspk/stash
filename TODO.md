# What's open

All nine phases in [`WORKPLAN.md`](WORKPLAN.md) are complete and every checkbox in it is
ticked. This is the shorter list: what is left, why, and what it would take.

**This file is an index, not the record.** Each item links to the section of `WORKPLAN.md`
that explains it — the reasoning lives there, so the two cannot drift into disagreeing about
anything that matters. Delete an item here when it is done; the narrative stays.

_Last reviewed: 2026-09-07._

---

## Needs a real deployment, or a real device

These cannot be done from a development machine. Each is the last unverified half of
something already built.

- [ ] **Confirm a pasted session turns a stub into a full article.** Phase 7b's actual "done
      when". The store works and sessions are in it; this specific claim — that replaying one
      makes a paywalled article arrive complete — has never been checked end to end on the
      deployment.

      **Now performable on any article.** Open one from a publisher you have a session for
      and press **Extract** — the control is offered whatever state the article is in, so it
      no longer has to be one Instapaper happened to return as a stub. The line under the
      headline then reads `EXTRACTED BY STASH, WITH YOUR SESSION`, which is the
      confirmation, and it comes from the server rather than from inference. For the second
      half of the "done when", sign out of that publisher and press **Re-extract**: it
      should come back a stub.

      None of that existed until now, which is why this item sat here twice looking like a
      two-minute job. **Take the update prompt first** — the app installs a new build and
      waits for you to accept it, so a merge alone does not change what is on screen.
      → [Phase 7b](WORKPLAN.md#7b--manual-site-sessions)
- [ ] **Install to the home screen on iOS, and open it offline there.** Phase 8's "done when".
      Running smoothly on an iPad in Safari is not the same claim as installing and cold-starting
      with no network. → [Phase 8](WORKPLAN.md#phase-8--offline-and-pwa-polish)
- [ ] **Lighthouse performance against the deployment.** The only measurement still owed.
      Accessibility, best practices and SEO are at 100 and do not depend on hosting; performance
      does, and simulated throttling over localhost is a model rather than a measurement.
      → [Phase 8's Lighthouse item](WORKPLAN.md#phase-8--offline-and-pwa-polish)

## Known gaps, found in use

Both are the same root seen from two ends, which is why neither has been fixed piecemeal.

- [ ] **Articles Instapaper returns "complete but imperfect" are never cleaned automatically.**
      The extraction-time cleaners live in `api/extract`, so an article that passes the truncation
      heuristic gets furniture removal at render and nothing else — no duplicate-title strip, no
      intro restore, no standfirst recovery. This is why one article opens at its second
      paragraph.

      **There is a manual answer now:** press **Extract** on such an article and our copy
      replaces Instapaper's, standfirst included. What is unsolved is doing it without being
      asked — the app cannot tell "complete" from "complete but missing its opening paragraph"
      without fetching the publisher's page, which is the expensive thing the heuristic exists
      to avoid. → [Open questions](WORKPLAN.md#open-questions)
- [x] ~~**A cached extraction never picks up an improved extractor.**~~ **Answered for one
      article at a time.** The reading view now offers **Re-extract** whenever an extraction is
      stored, not only when what is on screen still looks like a stub, so an article can be
      refetched against an improved extractor. What is *not* done is doing it in bulk: there is
      still no stored extractor version that would invalidate every cached extraction when the
      rules change. Whether that is worth building depends on how often the rules change, which
      is not yet known. → [Open questions](WORKPLAN.md#open-questions)

## Product decisions, worth making from use rather than now

- [ ] **Does a deep queue need an "all unread" list?** The front page shows fourteen articles.
      On a queue of fifty, the other thirty-six are on no screen in the app. Either the front
      page is the whole app and a deep queue is meant to be sampled, or there is a list behind
      it. → [Open questions](WORKPLAN.md#open-questions)
- [ ] **Split the routes into separate chunks?** One 411 kB bundle is what every remaining
      performance audit points at — unused JavaScript, unused CSS, render-blocking requests,
      network dependency tree, all the same fact. A deliberate architectural change, not a
      number to chase. → [Phase 8's Lighthouse item](WORKPLAN.md#phase-8--offline-and-pwa-polish)

## Waiting on you to try it

- [ ] **Why does the deployment get 403 where a laptop gets 200?** The probe reaches
      knack.be with a browser User-Agent and *no* session, gets 200, and is redirected to the
      publisher's SSO login — so the User-Agent was never the barrier and the extraction path
      works. The deployment, same URL, refuses.

      The remaining difference is where the request comes from: a serverless function in a
      datacentre versus a home connection, and datacentre ranges are routinely refused where a
      residential address is not. **A hypothesis, not a diagnosis.**

      Two ways to test it, both cheap. Add the session locally
      (`npm run session -- add knack.be`) and re-probe: a full article proves the whole path
      works from a laptop and isolates the difference to the deployment. Or fetch the same URL
      from any cloud shell with the same User-Agent: a 403 there confirms it is the address.

      If it is the address, no header fixes it, and the honest answer is the ceiling
      `docs/EXTRACTION.md` already describes — with the origin link in the reading bar as the
      fallback. → [WORKPLAN](WORKPLAN.md#the-user-agent-was-not-the-reason-and-the-probe-said-so-in-one-command)

## Small and optional

- [ ] **`@mozilla/readability` carries a low-severity ReDoS advisory** (`<0.6.0`). Pre-existing
      and unrelated to anything built here; the fix is a breaking major bump, so it wants its own
      change and its own fixture run.
- [ ] **`engines.node` is unbounded** — `^20.19.0 || ^22.13.0 || >=24`, so the host follows Node
      to its next major automatically. Bound it to `^24` if you would rather the runtime not move
      underneath a deployment.
- [ ] **Sessions stored with a `www.` host cover less than they could.** They work for ordinary
      article URLs but not for the apex or other subdomains. Save each again at the apex, *then*
      sign out of the `www` one — the more specific match wins where both apply, so that order
      leaves no gap. → [SESSIONS.md](SESSIONS.md#which-host-to-use)
- [ ] **An `npm run audit` script**, if the Lighthouse pass should be repeatable. It was run from
      a scratch install rather than a dependency, on the grounds that it is heavy for something
      run rarely.

## Answered — not pending

Kept briefly so they are not re-opened by mistake.

- **The browser extension (7c) stays deferred indefinitely.** The cookie paste was the thing
  that would have justified it, and in use the paste was not what got in the way.
- **Column pagination on mobile Safari** was the plan's biggest engineering risk, with a
  vertical-scroll fallback held in reserve. The fallback was not needed.
