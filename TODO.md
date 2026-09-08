# What's open

The shorter list: what is left, why, and what it would take.

**This file is an index, not the record.** Each item links to the section of `WORKPLAN.md`
that explains it — the reasoning lives there, so the two cannot drift into disagreeing about
anything that matters. Delete an item here when it is done; the narrative stays.

_Last reviewed: 2026-09-08._

---

## Needs a real deployment, or a real device

Each is the last unverified half of something already built, and neither can be done from a
development machine.

- [ ] **Install to the home screen on iOS, and open it offline there.** Phase 8's "done when".
      Running smoothly on an iPad in Safari is not the same claim as installing and cold-starting
      with no network. → [Phase 8](WORKPLAN.md#phase-8--offline-and-pwa-polish)
- [ ] **Lighthouse performance against the deployment.** The only measurement still owed.
      Accessibility, best practices and SEO are at 100 and do not depend on hosting; performance
      does, and simulated throttling over localhost is a model rather than a measurement. The
      bundle is a little smaller than when that number was taken (402 kB against 411 kB), so
      the figure to beat is out of date in the app's favour.
      → [Phase 8's Lighthouse item](WORKPLAN.md#phase-8--offline-and-pwa-polish)

## Housekeeping left by the removal

- [ ] **Delete the dead environment variables, and detach the KV store.** Nothing reads
      `STASH_ENCRYPTION_KEY`, `STASH_KV_*`, `KV_REST_API_*`, `UPSTASH_REDIS_*`, `REDIS_URL`,
      `STASH_REDIS_URL` or `STASH_USER_AGENT` any more. Harmless while they sit there, and
      `verify:build` still guards their values, but a variable nobody reads is a question
      somebody will waste an hour on later.
      → [Removing Stash's own fetching](WORKPLAN.md#removing-stashs-own-fetching)

## Known gaps, accepted rather than open

Kept because they are real costs of a decision, not because anyone is working on them.

- **Articles Instapaper returns "complete but imperfect" stay imperfect.** An article whose
  opening paragraph is missing — because the publisher marks the standfirst up outside the
  article container, and Instapaper's extractor drops it — is now shown as it came. Stash had
  a recovery for exactly this and it went with the fetching lane. The link to the publisher's
  page is the answer. → [Removing Stash's own
  fetching](WORKPLAN.md#removing-stashs-own-fetching)
- **A stub stays a stub.** Paywalled, script-built and anti-bot-protected pages were the
  reason for fetching them ourselves, and the two publishers tested seriously turned out to
  be ceilings either way. Same answer: the origin link.

## Product decisions, worth making from use rather than now

- [ ] **Does a deep queue need an "all unread" list?** The front page shows fourteen articles.
      On a queue of fifty, the other thirty-six are on no screen in the app. Either the front
      page is the whole app and a deep queue is meant to be sampled, or there is a list behind
      it. → [Open questions](WORKPLAN.md#open-questions)
- [ ] **Split the routes into separate chunks?** One 402 kB bundle is what every remaining
      performance audit points at — unused JavaScript, unused CSS, render-blocking requests,
      network dependency tree, all the same fact. A deliberate architectural change, not a
      number to chase.
      → [Phase 8's Lighthouse item](WORKPLAN.md#phase-8--offline-and-pwa-polish)

## Small and optional

- [ ] **`engines.node` is unbounded** — `^20.19.0 || ^22.13.0 || >=24`, so the host follows Node
      to its next major automatically. Bound it to `^24` if you would rather the runtime not move
      underneath a deployment.
- [ ] **An `npm run audit` script**, if the Lighthouse pass should be repeatable. It was run from
      a scratch install rather than a dependency, on the grounds that it is heavy for something
      run rarely.

## Answered — not pending

Kept briefly so they are not re-opened by mistake.

- **Stash's own fetching is removed, deliberately and in full.** Publisher sessions, the KV
  store, the extraction endpoint and the probe are all gone. Two publishers were tested to a
  conclusion and both were ceilings; no case was ever confirmed where our extraction beat
  Instapaper's on an article actually being read. Re-adding it is a product decision to argue
  from evidence, not a gap to fill. → [Removing Stash's own
  fetching](WORKPLAN.md#removing-stashs-own-fetching)
- **The browser extension (7c) is moot.** It existed to make the cookie paste pleasant, and
  there is no longer anything to paste.
- **`@mozilla/readability`'s ReDoS advisory** no longer applies — the dependency is gone.
- **Column pagination on mobile Safari** was the plan's biggest engineering risk, with a
  vertical-scroll fallback held in reserve. The fallback was not needed.
