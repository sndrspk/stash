# Fonts

All four families are licensed under the [SIL Open Font License 1.1][ofl], which permits
bundling and redistribution — including self-hosting them here, as Stash does.

| Family         | Files                                                             | Designer(s)                        |
| -------------- | ----------------------------------------------------------------- | ---------------------------------- |
| Source Serif 4 | `source-serif-4-latin.woff2`, `source-serif-4-italic-latin.woff2` | Frank Grießhammer (Adobe)          |
| Crimson Pro    | `crimson-pro-latin.woff2`, `crimson-pro-italic-latin.woff2`       | Jacques Le Bailly, Sebastian Kosch |
| Piazzolla      | `piazzolla-latin.woff2`, `piazzolla-italic-latin.woff2`           | Huerta Tipográfica                 |
| Geist          | `geist-latin.woff2`                                               | Vercel                             |

Each file is the **latin subset** of the family's **variable** font, with a weight axis of
400–700 — so one file covers every weight the reading view offers, and there is no separate
bold to download.

Geist ships no italic on Google Fonts. It is the UI face, where italics are close to unused;
browsers synthesise an oblique if anything ever needs one.

Sourced from Google Fonts via `npm run fonts` ([`scripts/fonts.ts`](../../scripts/fonts.ts)),
which fetches the current revision and writes it here. The files are committed on purpose: a
build must not depend on Google being reachable, and an installed PWA has to render offline
in whichever face the reader chose.

[ofl]: https://openfontlicense.org/
