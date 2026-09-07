# Stash — working notes for Claude

A read-it-later PWA for Instapaper with a newspaper-style front page. Single-tenant by
design: no accounts, no shared backend, one deployment per reader.

[`WORKPLAN.md`](WORKPLAN.md) is the running record and the place decisions are written
down. When a change alters behaviour someone would otherwise rediscover the hard way,
it belongs there — the file is deliberately a narrative, not a checklist.

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
- **The client must not reach `linkedom` or `@mozilla/readability`.** A browser has a
  DOM; those exist to give a serverless function one. `src/lib/furniture.ts` is the
  render-time cleaner on the platform's `DOMParser`; `src/lib/cleaners.ts` is the
  extraction-time trio on linkedom. Importing the latter from `src/routes`,
  `src/components` or `src/hooks` puts ~470 KiB of parser back in the bundle. See
  `test/client-bundle.test.ts`.
- **`ioredis` is server-only too**, and for a harder reason than the parsers: it opens TCP
  sockets, which a browser cannot do at all. `src/lib/kv.ts` imports it and sits beside
  modules the client does use, so the wrong import is one autocomplete away. Same test.
- **Secrets are never `VITE_`-prefixed.** Anything so named is inlined into the client
  bundle by design, and `import.meta.env` looks close enough to `process.env` that
  reaching for the wrong one is a natural and silent mistake. `npm run verify:build`
  greps `dist/` for each secret's value and refuses `VITE_`-prefixed secrets in source.

## Rules the code holds itself to

- **A signal, never a publisher.** No cleaner or extraction rule may key on a site's
  name or domain. A hostname list rots silently and is wrong for every site not on it.
- **Cookie values never travel back to the client.** Publisher sessions go in; only
  cookie *names* come out. There is no endpoint that returns a value, and diagnostics
  name variables rather than echoing them.
- **Instapaper is read, archived and deleted — never written to.** There is no
  `bookmarks/add`. The constraint list in the README is the authority.
- **Article HTML is untrusted**, from `get_text` and doubly so from our own extraction.
  Sanitize before injecting.
- **Say what happened, not what it probably means.** Error surfaces name the variable,
  the status or the actual exception. Two separate incidents in `WORKPLAN.md` cost real
  time to messages that described a symptom while the process held the cause —
  `test/config-diagnostics.test.ts` and `describeKvEnv` in `src/lib/kv.ts` both exist
  because of it.

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
