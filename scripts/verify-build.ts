/**
 * Proves that no secret reached the built bundle.
 *
 * The risk is specific and Vite makes it easy to hit: anything named `VITE_*` is
 * **inlined into the client bundle by design**, and `import.meta.env` looks close
 * enough to `process.env` that reaching for one where the other belongs is a natural
 * mistake. It is also a silent one — the app works perfectly, and the token is simply
 * sitting in a JavaScript file the whole internet can read.
 *
 * So this checks the built output rather than the source. Two questions:
 *
 *   1. Does any secret's *value* appear in `dist/`? This is the real test, and it can
 *      only be run where the values are — a machine with a `.env`, or CI with the
 *      variables set. It is skipped, loudly, when they are absent.
 *   2. Does any secret's *name* appear as a `VITE_`-prefixed variable anywhere in the
 *      source? This one runs everywhere, needs no values, and catches the mistake at
 *      the moment it is made rather than at the moment it is deployed.
 *
 * Run by `npm run verify:build`, and by `npm run check` after a build.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const DIST = join(ROOT, 'dist');

/**
 * Every variable whose value must never reach a browser.
 *
 * Listed by name rather than derived from `process.env`, so that adding a secret and
 * forgetting to add it here is a visible omission in a diff rather than a silent gap.
 */
export const SECRET_VARS = [
  'INSTAPAPER_CONSUMER_KEY',
  'INSTAPAPER_CONSUMER_SECRET',
  'INSTAPAPER_OAUTH_TOKEN',
  'INSTAPAPER_OAUTH_TOKEN_SECRET',
  'STASH_PASSPHRASE',
  'STASH_ENCRYPTION_KEY',
  'STASH_KV_TOKEN',
  'KV_REST_API_TOKEN',
  'UPSTASH_REDIS_REST_TOKEN',
] as const;

/**
 * A value too short or too common to search for without drowning in false positives.
 *
 * Twelve characters is well under any real credential and well over the length at
 * which a random string collides with minified JavaScript. A placeholder like
 * `changeme` is caught by the length rule, which is the right outcome: it is not a
 * secret, and reporting it would train someone to ignore this script.
 */
const MIN_SEARCHABLE = 12;

/** Files a bundler can put source into. Images and fonts cannot carry a token. */
const TEXTUAL = /\.(js|mjs|cjs|css|html|json|map|webmanifest|txt|svg)$/i;

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (TEXTUAL.test(entry.name)) out.push(full);
  }
  return out;
}

export interface Finding {
  variable: string;
  file: string;
}

/** Search built files for each value. Returns every hit, not just the first. */
export async function findLeakedValues(
  files: readonly string[],
  secrets: ReadonlyMap<string, string>,
): Promise<Finding[]> {
  const findings: Finding[] = [];

  for (const file of files) {
    let contents: string;
    try {
      contents = await readFile(file, 'utf8');
    } catch {
      continue;
    }
    for (const [variable, value] of secrets) {
      if (contents.includes(value)) findings.push({ variable, file: relative(ROOT, file) });
    }
  }

  return findings;
}

/**
 * Any `import.meta.env.VITE_…` reference whose name looks like one of our secrets.
 *
 * A source-level check, because by the time a `VITE_`-prefixed secret is in `dist/`
 * the mistake has already been made — and on a machine without the values, the
 * value-search above would not notice.
 */
export function findViteReferences(source: string): string[] {
  const names = new Set<string>();
  for (const match of source.matchAll(/\bVITE_[A-Z0-9_]+/g)) {
    const name = match[0];
    if (SECRET_VARS.some((secret) => name.includes(secret) || secret.includes(name.slice(5)))) {
      names.add(name);
    }
  }
  return [...names];
}

async function main(): Promise<void> {
  const files = await walk(DIST);
  if (files.length === 0) {
    console.error('No built output in dist/. Run `npm run build` first.');
    process.exitCode = 1;
    return;
  }

  // --- the source check, which runs everywhere ---
  const sources = [
    ...(await walk(join(ROOT, 'src'))),
    ...(await walk(join(ROOT, 'api'))),
    join(ROOT, 'vite.config.ts'),
    join(ROOT, 'index.html'),
  ];
  const viteHits: string[] = [];
  for (const file of sources) {
    try {
      for (const name of findViteReferences(await readFile(file, 'utf8'))) {
        viteHits.push(`${relative(ROOT, file)}: ${name}`);
      }
    } catch {
      // Unreadable or absent; nothing to check.
    }
  }

  if (viteHits.length > 0) {
    console.error('A secret is exposed to the client bundle through a VITE_ variable:\n');
    for (const hit of viteHits) console.error(`  ${hit}`);
    console.error('\nAnything named VITE_* is inlined into the bundle. Read it in a function');
    console.error('from process.env instead.');
    process.exitCode = 1;
    return;
  }

  // --- the value check, which needs the values ---
  const secrets = new Map<string, string>();
  const short: string[] = [];
  for (const name of SECRET_VARS) {
    const value = process.env[name]?.trim();
    if (value === undefined || value === '') continue;
    if (value.length < MIN_SEARCHABLE) {
      short.push(name);
      continue;
    }
    secrets.set(name, value);
  }

  if (secrets.size === 0) {
    /*
     * Not a pass and not a failure. Saying "no secrets found in the bundle" here
     * would be true and useless — there was nothing to look for — and it is exactly
     * the sentence someone would remember having seen when the real check never ran.
     */
    console.log(`Checked ${String(files.length)} built files. No VITE_-exposed secrets.`);
    console.log(
      'The value search was SKIPPED: no secret environment variables are set here, so there was nothing to search for.',
    );
    console.log('Run it with a .env present, or in CI with the deployment variables set.');
    return;
  }

  const findings = await findLeakedValues(files, secrets);

  if (findings.length > 0) {
    // The value itself is never printed. This output may end up in a CI log.
    console.error('A secret value is present in the built output:\n');
    for (const { variable, file } of findings) console.error(`  ${variable} → ${file}`);
    process.exitCode = 1;
    return;
  }

  console.log(
    `Checked ${String(files.length)} built files against ${String(secrets.size)} secrets. Nothing leaked.`,
  );
  if (short.length > 0) {
    console.log(
      `Too short to search for safely, so not checked: ${short.join(', ')}. If those are real secrets rather than placeholders, they are too weak.`,
    );
  }
}

// Only when run as a script; the exported helpers are tested directly.
if (process.argv[1]?.endsWith('verify-build.ts') === true) {
  await main();
}
