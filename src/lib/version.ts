/**
 * Which build is on screen.
 *
 * Numbered by the pull request that shipped it, because that is the number a reader
 * already has: "did the fix land?" is answered by comparing what the masthead says
 * against the PR that was merged, with nothing to look up in between.
 *
 * **Bump this in the PR that ships the change, and use that PR's own number.** It is
 * the one thing here that cannot be derived: a production build runs from `main` after
 * the merge, and nothing in that environment knows which pull request it came from.
 * `VERCEL_GIT_COMMIT_SHA` is available and truthful but answers a different question —
 * it identifies a commit, not a change someone reviewed.
 *
 * The cost of the manual step is that it can be forgotten, and a stale number is worse
 * than none: it would say a fix is live when it is not. `test/version.test.ts` cannot
 * check it against reality, so it checks the shape and leaves the rest to the habit
 * recorded in `CLAUDE.md`.
 *
 * This exists because a merged change appeared to do nothing. The app installs a new
 * build and waits for the reader to accept it, so "I merged it" and "I am running it"
 * are different claims, and there was no way to tell them apart from the screen.
 */
export const APP_VERSION = 33;

/** As shown: `v33`. */
export const versionLabel = (version: number = APP_VERSION): string => `v${String(version)}`;
