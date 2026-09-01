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
  describeResponse,
  assignShapes,
  measure,
  toFixtureBookmark,
  type Candidate,
  type FixtureBookmark,
  type Measurements,
  type Outcome,
  type Shape,
} from '../src/lib/fixtures.js';
import { callText, credentialsFromEnv, call } from '../src/lib/instapaper.js';
import { parseBookmarkList } from '../src/lib/sync.js';

const OUT = 'fixtures';
const RAW = 'fixtures/.raw';

/** Polite spacing between calls. A one-off capture has no reason to hurry. */
const DELAY_MS = 700;

/**
 * Fixtures that already cover a shape, independently of any capture.
 *
 * Without this the manifest reports `soft-paywall` as having no candidate, which is
 * true of the sample and misleading about the fixture set: the case is covered, by a
 * hand-built pair committed for the Phase 7a extraction probe. A reader comparing the
 * table against the plan's six shapes would conclude a case was untested when it is
 * the one case with *two* files — the stub and the full page it is compared to.
 *
 * Their provenance is different from a captured file and the row says so, because
 * "constructed to have this property" and "found to have it" are different claims.
 */
const STANDING: Partial<Record<Shape, { files: string; note: string }>> = {
  'soft-paywall': {
    files: '`../soft-paywall-stub.html` + `../soft-paywall-full.html`',
    note: 'hand-built for the Phase 7a extraction probe, not from this capture',
  },
};

/** How many bookmark records land in bookmarks.json. */
const RECORD_COUNT = 20;

/**
 * How many bookmarks to ask `bookmarks/list` for — the API's maximum.
 *
 * Only `--limit` of them are fetched for text, so this costs one response rather
 * than N calls. It is deliberately larger than any sample: asking for exactly as
 * many as we intend to sample makes "the list came back full" and "that is the whole
 * folder" indistinguishable, and then no advice about widening the sample can be
 * honest. With headroom, a short list means a short folder.
 */
const LIST_LIMIT = 500;

const flag = (name: string) => argv.includes(`--${name}`);
const option = (name: string, fallback: number): number => {
  const at = argv.indexOf(`--${name}`);
  const value = at >= 0 ? Number(argv[at + 1]) : NaN;
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const text = (name: string, fallback: string): string => {
  const at = argv.indexOf(`--${name}`);
  const value = at >= 0 ? argv[at + 1] : undefined;
  return value && !value.startsWith('--') ? value : fallback;
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
  outcome: Outcome;
  note?: string;
}

/**
 * `get_text` for one bookmark, and — the part that matters — what kind of answer it
 * was.
 *
 * A **refusal** is data, not an error: an article Instapaper will not give up is
 * exactly the hard-paywall shape the fixture set needs, so it is recorded with an
 * empty body and a note rather than aborting the run.
 *
 * A **failed transfer** is not that. It is a fact about the network, so it is tagged
 * `unreachable` and dropped from selection entirely.
 *
 * And an **article with no prose** — a 200 carrying real markup for a page that is
 * all video or embed — is not that either. It is an article, and it happens to have
 * nothing to read.
 *
 * All three arrive at `measure()` as zero characters, which is why this distinction
 * has to be made here and carried. Deriving it downstream picked the wrong article
 * twice: first a timeout, then a video page.
 */
async function fetchText(
  id: number,
  credentials: ReturnType<typeof credentialsFromEnv>,
): Promise<{ html: string; outcome: Outcome; note?: string }> {
  try {
    const { status, body } = await callText(
      '/api/1.1/bookmarks/get_text',
      [['bookmark_id', String(id)]],
      credentials,
      AbortSignal.timeout(30_000),
    );

    if (status !== 200) {
      return { html: '', outcome: 'refused', note: `get_text returned HTTP ${status}` };
    }

    // A 200 can still carry an error object rather than an article.
    const trimmed = body.trimStart();
    if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
      try {
        const parsed: unknown = JSON.parse(body);
        const first = Array.isArray(parsed) ? parsed[0] : parsed;
        if (typeof first === 'object' && first !== null && 'error_code' in first) {
          return {
            html: '',
            outcome: 'refused',
            note: `Instapaper error ${String((first as { error_code: unknown }).error_code)}`,
          };
        }
      } catch {
        // Not JSON after all; fall through and treat it as markup.
      }
    }

    // A 200 with nothing in it is a refusal too — Instapaper answered and the answer
    // has no article. Markup with no prose is not: that is a real page that happens
    // to be all video or embed, and it is the case that was misfiled as a paywall.
    if (!body.trim()) return { html: '', outcome: 'refused', note: 'get_text returned nothing' };

    return { html: body, outcome: 'article' };
  } catch (error) {
    const timedOut = error instanceof Error && error.name === 'TimeoutError';
    return {
      html: '',
      outcome: 'unreachable',
      note: timedOut ? 'get_text timed out' : 'get_text was unreachable',
    };
  }
}

/**
 * One line saying what came back, in terms that distinguish the cases.
 *
 * "0 chars, 0 img, 1 wide" is true of a page with no prose and says nothing about
 * whether Instapaper refused it — which is exactly the ambiguity that let a video
 * page be chosen as the paywall fixture and survive a read of the output.
 */
function describe(item: Captured): string {
  if (item.note) return item.note;

  const m = item.measurements;
  const shape = `${m.chars} chars, ${m.images} img, ${m.wideBlocks} wide`;
  return m.chars === 0 ? `${shape} — markup, but no prose (not a refusal)` : shape;
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

  const folder = text('folder', 'unread');

  console.log('\nStash — fixture capture\n');
  console.log(`Fetching the "${folder}" folder…`);

  const raw = await call(
    '/api/1.1/bookmarks/list',
    [
      ['folder_id', folder],
      ['limit', String(LIST_LIMIT)],
    ],
    credentials,
    AbortSignal.timeout(30_000),
  );

  const bookmarks = parseBookmarkList(raw);

  if (bookmarks.length === 0) {
    /*
     * "No bookmarks parsed" and "the folder is empty" are different claims, and
     * only one of them is something this code can actually know. Print what came
     * back instead of asserting a cause: an empty folder and a response we failed
     * to understand look identical from here, and telling someone their folder is
     * empty when it is not sends them looking in the wrong place entirely.
     */
    console.error('\nNo bookmarks parsed from the response.\n');
    console.error(describeResponse(raw));
    console.error(
      '\nIf the tally above shows bookmark entries, the parser is at fault — send me\n' +
        'this output. If it shows none, the folder really is empty. To check that the\n' +
        'endpoint works at all, try a folder you know has something in it:\n\n' +
        '  npm run capture -- --dry-run --folder archive\n' +
        '  npm run capture -- --dry-run --folder starred\n',
    );
    exit(1);
  }

  console.log(`  ${bookmarks.length} bookmarks.\n`);

  const sample = bookmarks.slice(0, limit);
  console.log(`Fetching article text for ${sample.length} of them (${DELAY_MS}ms apart)…`);

  const captured: Captured[] = [];
  for (const [index, bookmark] of sample.entries()) {
    if (index > 0) await sleep(DELAY_MS);
    const { html, outcome, note } = await fetchText(bookmark.bookmark_id, credentials);
    const measurements = measure(html);
    captured.push({ bookmark, html, measurements, outcome, note });

    console.log(
      `  [${index + 1}/${sample.length}] ${bookmark.bookmark_id}  ${describe(captured.at(-1)!)}`,
    );
  }

  const candidates: Candidate[] = captured.map((c) => ({
    bookmarkId: c.bookmark.bookmark_id,
    measurements: c.measurements,
    outcome: c.outcome,
  }));
  const assigned = assignShapes(candidates);

  const unreachable = captured.filter((c) => c.outcome === 'unreachable').length;
  if (unreachable) {
    // Said plainly, because it means the sample was smaller than the number above:
    // these are excluded from every shape, a timeout being a fact about the network
    // rather than about the article.
    console.log(
      `\n${unreachable} of ${sample.length} never completed and are excluded from the\n` +
        'shapes below. Re-running usually reaches them.',
    );
  }

  /*
   * Each row says why the article was chosen, not just which one. Without that,
   * checking the classification means cross-referencing an id against every line
   * above — and a wrong choice reads as plausible. Two of them did.
   */
  console.log('\nShapes:');
  for (const shape of SHAPES) {
    const id = assigned.get(shape);
    if (!id) {
      const standing = STANDING[shape];
      console.log(
        `  ${shape.padEnd(13)} ${standing ? `already covered — ${standing.note}` : '— no candidate found'}`,
      );
      continue;
    }
    const item = captured.find((c) => c.bookmark.bookmark_id === id)!;
    console.log(`  ${shape.padEnd(13)} bookmark ${id}  ${describe(item)}`);
  }

  // A shape with a standing fixture is not missing, so widening the sample for it
  // would be advice to solve a problem that does not exist.
  const missing = SHAPES.filter((s) => !assigned.has(s) && !STANDING[s]);
  if (missing.length) {
    /*
     * The advice has to reflect the run that just happened. A hard-coded
     * "re-run with --limit 40" told someone who had just used --limit 40 to do the
     * thing they had already done, and said nothing about the case where widening is
     * not even possible because the sample was the whole folder.
     */
    const room = bookmarks.length - sample.length;
    const truncatedList = bookmarks.length >= LIST_LIMIT;
    console.log(
      `\nNote: ${missing.length} shape(s) had no candidate among the ${sample.length} sampled.\n` +
        (room > 0
          ? `Re-run with \`--limit ${Math.min(limit * 2, bookmarks.length)}\` to widen it — ` +
            `${room} more ${truncatedList ? 'were listed' : 'in the folder'}.\n` +
            'Or accept the gap: a fixture set that says a shape is missing beats one\n' +
            'padded with an article that lacks the property.'
          : 'That was every bookmark listed, so widening will not help — the shape is\n' +
            'simply not present. A fixture set that says so beats one padded with an\n' +
            'article that lacks the property.'),
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
      const standing = STANDING[shape];
      manifest.push(
        standing
          ? `| \`${shape}\` | ${standing.files} | ${standing.note} |`
          : `| \`${shape}\` | — | no candidate in the captured sample |`,
      );
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

  await writeFile(`${OUT}/MANIFEST.md`, renderManifest(manifest, records.length, sample.length));

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

function renderManifest(rows: string[], recordCount: number, sampleSize: number): string {
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
- **hard-paywall** — Instapaper *refused*: an HTTP error, an error code, or an empty
  body. Must fail with a legible tag rather than an exception. Chosen on what the
  response was, never on how little prose it had — an article with markup but no
  prose is a video page, and a timeout is a network fault. Both look identical to a
  character count, and both have been misfiled here.
- **image-heavy** — exercises Phase 4's resolution and Phase 6's media clamping.
- **wide-embeds** — tables, iframes and \`pre\` blocks: the things that overflow a
  column if \`--reading-column-width\` is not applied.
- **very-long** — the case where Phase 6's deterministic column count matters most.
- **short** — fewer columns than the viewport can show, which is its own edge.

A shape whose row reads \`—\` had no candidate among the ${sampleSize} articles sampled.
Re-run with a larger \`--limit\` to widen the search, or leave the gap: an honest hole
beats a file that does not have the property its row claims.

A row naming a file outside \`text/\` is a **standing fixture**: it covers that shape
independently of any capture and is not overwritten by one. \`soft-paywall\` is the
case — it needs a stub *and* the full page it is compared against, which is a pair no
single captured article can be, so it was built by hand for the Phase 7a extraction
probe. That distinction matters when reading the table: constructed to have a property
and found to have it are different claims.

Articles whose \`get_text\` call never completed are excluded from selection entirely. A
timeout arrives looking exactly like a hard paywall — zero characters — but it is a
fact about the network, not about the article.

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
      '  --folder ID   unread (default), starred, archive, or a folder id\n' +
      '  --dry-run     fetch and report, write nothing\n' +
      '  --keep-raw    also write untouched originals to fixtures/.raw (git-ignored)\n\n' +
      'Requires the four Instapaper values in .env. Output is anonymised: structure\n' +
      'kept, words replaced.\n',
  );
  exit(0);
}

await main();
