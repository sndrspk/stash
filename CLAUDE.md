# Stash — working notes for Claude

A read-it-later PWA for Instapaper with a newspaper-style front page. Single-tenant by
design: no accounts, no shared backend, one deployment per reader.

[`WORKPLAN.md`](WORKPLAN.md) is the running record and the place decisions are written
down. When a change alters behaviour someone would otherwise rediscover the hard way,
it belongs there — the file is deliberately a narrative, not a checklist.

[`TODO.md`](TODO.md) is the checklist, and it is an index rather than a second record:
every item points at the `WORKPLAN.md` section that explains it. Finish something and
delete its line there; the reasoning stays where it was written. Adding an item to one
file and not the other is how the two start disagreeing.

## Branches and pull requests

Work happens on the designated branch, one PR at a time, and **each PR is merged before
the next piece of work starts**. So before committing anything new:

```sh
git fetch origin main
git log --oneline origin/main..HEAD   # anything here is unmerged work — keep it
```

- If the last PR is merged and the branch carries nothing unmerged, restart it from
  main before committing: `git checkout -B <branch> origin/main`.
- If it carries unmerged commits, rebase them onto `origin/main` rather than dropping
  them.
- Never stack new commits on already-merged history; a merged PR cannot track new work.
- Push, then open a **new** PR. Don't reuse the merged one.

Do this *before* the commit, not after the push. Discovering it afterwards means a
rebase and a force-push that could have been avoided.

## The version badge

`APP_VERSION` in `src/lib/version.ts` is shown beside the wordmark. **Bump it in the
PR that ships the change, to that PR's own number.** It cannot be derived — a
production build runs from `main` after the merge and has no idea which pull request
it came from — so it is a habit, not a mechanism, and `test/version.test.ts` can only
check its shape and that it never goes backwards.

A stale number is worse than none: it says a fix is live when it is not.

## Before you push

```sh
npm run check          # lint, format, typecheck, tests
npm run check:deploy   # the above, plus a production build and a secrets scan of dist/
```

## Conventions that are enforced by tests

These are not style preferences — a test fails if they are broken, and each exists
because something shipped broken once.

- **Relative imports in `api/` and `src/lib/` carry a `.js` extension.** Those run as
  real Node ESM, where extensionless specifiers do not resolve. Nothing local catches
  it: Vite, Vitest and `vercel dev` all resolve them, and only the deployment fails —
  as `FUNCTION_INVOCATION_FAILED`, naming nothing. See `test/module-resolution.test.ts`.
- **The client must not reach `linkedom`, nor a `node:` builtin.** A browser has a DOM;
  `linkedom` exists to give a serverless function one, and it is still a dependency —
  `src/lib/og-image.ts` parses a publisher's page with it to find the `og:image`.
  `src/lib/furniture.ts` is the render-time cleaner on the platform's own `DOMParser`,
  and importing the wrong one puts ~470 KiB of parser stack back in the bundle, which is
  exactly what happened once. `node:` is the harder version of the same rule:
  `src/lib/fetch-guard.ts` imports `node:dns/promises` to vet every outbound address and
  sits in `src/lib` beside modules the client uses every render, so the wrong import is
  one autocomplete away — and that one is a build that fails, not merely dead weight. See
  `test/client-bundle.test.ts`, which also still guards `@mozilla/readability` and
  `ioredis` against reintroduction now that neither is installed.
- **Secrets are never `VITE_`-prefixed.** Anything so named is inlined into the client
  bundle by design, and `import.meta.env` looks close enough to `process.env` that
  reaching for the wrong one is a natural and silent mistake. `npm run verify:build`
  greps `dist/` for each secret's value and refuses `VITE_`-prefixed secrets in source.

## Rules the code holds itself to

- **A signal, never a publisher.** No cleaning rule may key on a site's name or domain.
  A hostname list rots silently and is wrong for every site not on it.
- **Stash does not fetch article text.** It reads `get_text` and renders that. The
  fetching lane — publisher sessions, a KV store, our own extraction — was built, used
  and removed; `WORKPLAN.md` has the measurements. Re-adding it is a product decision to
  be argued from evidence, not a gap to be quietly filled.
- **Instapaper is read, archived and deleted — never written to.** There is no
  `bookmarks/add`. The constraint list in the README is the authority.
- **Article HTML is untrusted.** `get_text` returns third-party markup, and arriving
  through an API we trust does not make its contents trustworthy. Sanitize before
  injecting.
- **So is a bookmark's URL.** It comes from Instapaper, and rendering one as an `href`
  goes nowhere near DOMPurify — React escapes text but renders `javascript:` without
  complaint. `externalHref` in `src/lib/sanitize.ts` is the only way one reaches the DOM.
- **Say where the text came from, and link to the original.** There is one source now,
  so the line under the headline is short — but it renders unconditionally, and the link
  beside it is the whole answer for an article Instapaper could not extract. The rule
  survives the thing that motivated it: a reader comparing a cleaned copy against the
  publisher's page should never have to guess what they are looking at.
- **Say what happened, not what it probably means.** Error surfaces name the variable,
  the status or the actual exception. Two separate incidents in `WORKPLAN.md` cost real
  time to messages that described a symptom while the process held the cause —
  `test/config-diagnostics.test.ts` exists because of it, as did `describeKvEnv` before
  the KV store went. `test/probe-verdict.test.ts` was a third instance and went with the
  probe: three separate verdicts there asserted more than their data supported, and every
  one was caught by someone running the tool rather than reading it.

## Comments

Dense and explanatory, and they earn their length: they say *why*, and they record the
failure that motivated the rule. Match that register rather than annotating what the
next line does. Two tests scan source for imports and strip comments first
(`test/source-scan.ts`) precisely so that documenting a rule cannot break it.

## Verifying

The bar in this project is a claim about something real. "Tests pass" is not the same
as "it works": the suite has twice agreed with itself while the feature was broken —
the offline queue behind a paused mutation, and jsdom standing in for a browser. When a
change depends on a runtime the tests stub, drive the real one and say which you did.
