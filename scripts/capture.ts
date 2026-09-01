/**
 * `npm run capture` — builds the fixture set from a real Instapaper account.
 *
 * Fetches the unread list, pulls `get_text` for a sample of it, measures each
 * article, and picks one representative per shape: soft paywall, hard paywall,
 * image-heavy, wide embeds, very long, short. Those are the shapes that break the
 * front page and the reading view, which is why the plan asks for them by name
 * rather than for "some articles".
 *
 * **What it writes is anonymised.** Structure is kept exactly — every tag,
 * attribute, image dimension and character count — and every word is replaced.
 * See `src/lib/fixtures.ts` for why: the fixtures land in a public repository, the
 * bookmark list is a record of what someone reads, and the article bodies are
 * publishers' prose. Neither needs publishing to serve the purpose these files
 * have.
 *
 * `--keep-raw` additionally writes the untouched originals to `fixtures/.raw/`,
 * which is git-ignored. Useful for eyeballing what was captured; never committed.
 *
 * Usage:
 *   npm run capture                 sample 20 articles, write anonymised fixtures
 *   npm run capture -- --limit 30   sample more
 *   npm run capture -- --dry-run    fetch and report, write nothing
 *   npm run capture -- --keep-raw   also keep the originals locally
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { argv, env, exit } from 'node:process';

import {
  SHAPES,
  anonymizeHtml,
  assignShapes,
  measure,
  toFixtureBookmark,
  type Candidate,
  type FixtureBookmark,
  type Measurements,
} from '../src/lib/fixtures.js';
import { callText, credentialsFromEnv, call } from '../src/lib/instapaper.js';
import { parseBookmarkList } from '../src/lib/sync.js';

const OUT = 'fixtures';
const RAW = 'fixtures/.raw';

/** Polite spacing between calls. A one-off capture has no reason to hurry. */
const DELAY_MS = 700;

/** How many bookmark records land in bookmarks.json. */
const RECORD_COUNT = 20;

const flag = (name: string) => argv.includes(`--${name}`);
const option = (name: string, fallback: number): number => {
  const at = argv.indexOf(`--${name}`);
  const value = at >= 0 ? Number(argv[at + 1]) : NaN;
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function fail(message: string): never {
  console.error(`\n${message}\n`);
  exit(1);
}

interface Captured {
  bookmark: FixtureBookmark;
  html: string;
  measurements: Measurements;
  note?: string;
}

/**
 * `get_text` for one bookmark.
 *
 * A failure is data, not an error: an article Instapaper cannot parse is exactly
 * the hard-paywall shape the fixture set needs, so it is recorded with an empty
 * body and a note rather than aborting the run.
 */
async function fetchText(
  id: number,
  credentials: ReturnType<typeof credentialsFromEnv>,
): Promise<{ html: string; note?: string }> {
  try {
    const { status, body } = await callText(
      '/api/1.1/bookmarks/get_text',
      [['bookmark_id', String(id)]],
      credentials,
      AbortSignal.timeout(30_000),
    );

    if (status !== 200) return { html: '', note: `get_text returned HTTP ${status}` };

    // A 200 can still carry an error object rather than an article.
    const trimmed = body.trimStart();
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try {
        const parsed: unknown = JSON.parse(body);
        const first = Array.isArray(parsed) ? parsed[0] : parsed;
        if (typeof first === 'object' && first !== null && 'error_code' in first) {
          return {
            html: '',
            note: `Instapaper error ${String((first as { error_code: unknown }).error_code)}`,
          };
        }
      } catch {
        // Not JSON after all; fall through and treat it as markup.
      }
    }

    return { html: body };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    return { html: '', note: timedOut ? 'get_text timed out' : 'get_text was unreachable' };
  }
}

async function main(): Promise<void> {
  const dryRun = flag('dry-run');
  const keepRaw = flag('keep-raw');
  const limit = option('limit', 20);

  let credentials;
  try {
    credentials = credentialsFromEnv((name) => {
      const value = env[name];
      if (!value) throw new Error(name);
      return value;
    });
  } catch (error) {
    fail(
      `Missing ${error instanceof Error ? error.message : 'a credential'}.\n\n` +
        'All four Instapaper values must be in .env. Run `npm run connect` first if\n' +
        'you do not have the token pair yet.',
    );
  }

  console.log('\nStash — fixture capture\n');
  console.log('Fetching the unread list…');

  const raw = await call(
    '/api/1.1/bookmarks/list',
    [
      ['folder_id', 'unread'],
      ['limit', String(Math.max(limit, RECORD_COUNT))],
    ],
    credentials,
    AbortSignal.timeout(30_000),
  );

  const bookmarks = parseBookmarkList(raw);
  if (bookmarks.length === 0) fail('The unread folder is empty — nothing to capture.');

  console.log(`  ${bookmarks.length} bookmarks.\n`);

  const sample = bookmarks.slice(0, limit);
  console.log(`Fetching article text for ${sample.length} of them (${DELAY_MS}ms apart)…`);

  const captured: Captured[] = [];
  for (const [index, bookmark] of sample.entries()) {
    if (index > 0) await sleep(DELAY_MS);
    const { html, note } = await fetchText(bookmark.bookmark_id, credentials);
    const measurements = measure(html);
    captured.push({ bookmark, html, measurements, note });

    const label =
      note ??
      `${measurements.chars} chars, ${measurements.images} img, ${measurements.wideBlocks} wide`;
    console.log(`  [${index + 1}/${sample.length}] ${bookmark.bookmark_id}  ${label}`);
  }

  const candidates: Candidate[] = captured.map((c) => ({
    bookmarkId: c.bookmark.bookmark_id,
    measurements: c.measurements,
  }));
  const assigned = assignShapes(candidates);

  console.log('\nShapes:');
  for (const shape of SHAPES) {
    const id = assigned.get(shape);
    console.log(`  ${shape.padEnd(13)} ${id ? `bookmark ${id}` : '— no candidate found'}`);
  }

  const missing = SHAPES.filter((s) => !assigned.has(s));
  if (missing.length) {
    console.log(
      `\nNote: ${missing.length} shape(s) had no candidate in this sample. Re-run with\n` +
        '`--limit 40` to widen it, or accept the gap — a fixture set that says a shape\n' +
        'is missing beats one padded with an article that lacks the property.',
    );
  }

  if (dryRun) {
    console.log('\n--dry-run: nothing written.\n');
    return;
  }

  await mkdir(`${OUT}/text`, { recursive: true });

  // Anonymised bookmark records.
  const records = bookmarks.slice(0, RECORD_COUNT).map((b, i) => toFixtureBookmark(b, i * 7));
  await writeFile(`${OUT}/bookmarks.json`, JSON.stringify(records, null, 2) + '\n');

  // One anonymised article per shape.
  const manifest: string[] = [];
  for (const shape of SHAPES) {
    const id = assigned.get(shape);
    if (!id) {
      manifest.push(`| \`${shape}\` | — | no candidate in the captured sample |`);
      continue;
    }
    const item = captured.find((c) => c.bookmark.bookmark_id === id)!;
    const html = item.html ? anonymizeHtml(item.html) : '';
    await writeFile(`${OUT}/text/${shape}.html`, html + (html ? '\n' : ''));

    const m = item.measurements;
    manifest.push(
      `| \`${shape}\` | \`text/${shape}.html\` | ${
        item.note ?? `${m.chars} chars, ${m.paragraphs} p, ${m.images} img, ${m.wideBlocks} wide`
      } |`,
    );
  }

  await writeFile(`${OUT}/MANIFEST.md`, renderManifest(manifest, records.length));

  if (keepRaw) {
    await rm(RAW, { recursive: true, force: true });
    await mkdir(RAW, { recursive: true });
    for (const item of captured) {
      await writeFile(`${RAW}/${item.bookmark.bookmark_id}.html`, item.html);
    }
    await writeFile(`${RAW}/bookmarks.json`, JSON.stringify(bookmarks, null, 2) + '\n');
    console.log(`\nRaw originals in ${RAW}/ (git-ignored).`);
  }

  console.log(`\nWrote ${records.length} records and ${assigned.size} article fixtures.\n`);
  console.log('Before committing, read them:');
  console.log(`  cat ${OUT}/MANIFEST.md`);
  console.log(`  head -40 ${OUT}/text/very-long.html`);
  console.log(`  head -20 ${OUT}/bookmarks.json\n`);
  console.log('They are anonymised — structure kept, words replaced — but the plan says');
  console.log('never commit a fixture you have not read, and that is still the rule.\n');
}

function renderManifest(rows: string[], recordCount: number): string {
  return `# Fixtures

Generated by \`npm run capture\` from a real Instapaper account, then **anonymised**:
every tag, attribute, image dimension and character count is preserved exactly, and
every word is replaced with filler of the same shape.

That is deliberate, and it is not a lossy compromise for what these are for. Phase 5
picks front-page slots by whether an article has an image and how long its headline
is; Phase 6 computes a column count from the rendered height of the text. Both care
about how much text there is and how it is marked up — never about what it says.

Not anonymising would mean publishing two things that do not need publishing: a
record of what someone reads, and publishers' article prose.

## Article shapes

Each file is one article, chosen because it exhibits the shape in its row.

| Shape | File | Measured |
| --- | --- | --- |
${rows.join('\n')}

- **soft-paywall** — \`get_text\` returned something, but the truncation heuristic
  says it is not an article. The case Phase 7's extraction fallback exists for.
- **hard-paywall** — nothing came back at all. Must fail with a legible tag rather
  than an exception.
- **image-heavy** — exercises Phase 4's resolution and Phase 6's media clamping.
- **wide-embeds** — tables, iframes and \`pre\` blocks: the things that overflow a
  column if \`--reading-column-width\` is not applied.
- **very-long** — the case where Phase 6's deterministic column count matters most.
- **short** — fewer columns than the viewport can show, which is its own edge.

A shape with no file had no candidate in the captured sample. Re-run with
\`--limit 40\` to widen the search.

## Bookmark records

\`bookmarks.json\` holds ${recordCount} anonymised records with the six fields the app
reads. Fields Instapaper sends that Stash never reads — \`progress\`, \`starred\`,
\`private_source\` — are dropped rather than anonymised.

## Regenerating

\`\`\`sh
npm run capture              # anonymised fixtures, ready to commit
npm run capture -- --dry-run # report what would be captured, write nothing
npm run capture -- --keep-raw # also keep untouched originals in fixtures/.raw (git-ignored)
\`\`\`
`;
}

if (flag('help') || argv.includes('-h')) {
  console.log(
    '\nnpm run capture — build the fixture set from a real Instapaper account.\n\n' +
      '  --limit N     articles to sample for text (default 20)\n' +
      '  --dry-run     fetch and report, write nothing\n' +
      '  --keep-raw    also write untouched originals to fixtures/.raw (git-ignored)\n\n' +
      'Requires the four Instapaper values in .env. Output is anonymised: structure\n' +
      'kept, words replaced.\n',
  );
  exit(0);
}

await main();
