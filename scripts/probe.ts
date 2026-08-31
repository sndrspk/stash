#!/usr/bin/env tsx
/**
 * Does pasting a cookie header actually get you the full article?
 *
 * Answers that for one URL, before any of Stash exists. Fetches the page twice — once
 * anonymously, once replaying a stored session — and reports what each attempt got. If
 * the numbers are the same, the cookie bought you nothing for that publisher. If the
 * authenticated run is ten times longer, this is worth building.
 *
 *   npm run probe -- <url> [options]
 *
 *   --sessions <file>   session store (default: sessions.json)
 *   --anon-only         skip the authenticated attempt
 *   --auth-only         skip the anonymous attempt
 *   --file <path>       reduce a saved HTML file instead of fetching (no network)
 *   --out <file>        write the extracted article HTML for eyeballing
 *   --show <n>          print the first n characters of extracted text (default 300)
 *
 * Cookie VALUES are never printed. Names only — the same rule the real app follows.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { cookieHeaderFor, cookieNames, type SessionStore } from '../src/lib/cookies.js';
import { extract, extractFromHtml, type ExtractResult } from '../src/lib/extract.js';

const BOLD = '[1m';
const DIM = '[2m';
const RED = '[31m';
const GREEN = '[32m';
const YELLOW = '[33m';
const OFF = '[0m';

interface Args {
  url: string;
  sessions: string;
  anonOnly: boolean;
  authOnly: boolean;
  file: string | null;
  out: string | null;
  show: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    url: '',
    sessions: 'sessions.json',
    anonOnly: false,
    authOnly: false,
    file: null,
    out: null,
    show: 300,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--sessions') args.sessions = argv[++i] ?? args.sessions;
    else if (arg === '--file') args.file = argv[++i] ?? null;
    else if (arg === '--out') args.out = argv[++i] ?? null;
    else if (arg === '--show') args.show = Number(argv[++i] ?? args.show);
    else if (arg === '--anon-only') args.anonOnly = true;
    else if (arg === '--auth-only') args.authOnly = true;
    else if (arg !== undefined && !arg.startsWith('-') && args.url === '') args.url = arg;
  }
  return args;
}

async function loadSessions(path: string): Promise<SessionStore> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      console.error(`${RED}${path} must be a JSON object of host → cookie header.${OFF}`);
      return {};
    }
    return parsed as SessionStore;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.error(`${RED}Could not read ${path}: ${(error as Error).message}${OFF}`);
    }
    return {};
  }
}

const n = (value: number): string => value.toLocaleString('en-US');

function kb(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${Math.round(bytes / 1024)} KB`;
}

function report(label: string, result: ExtractResult): void {
  const head = `  ${BOLD}${label.padEnd(18)}${OFF}`;
  if (!result.ok) {
    console.log(`${head}${RED}failed${OFF}  ${result.tag}`);
    return;
  }
  const verdict = result.truncation.truncated
    ? `${YELLOW}looks truncated${OFF} ${DIM}(${result.truncation.reasons.join(', ')})${OFF}`
    : `${GREEN}looks complete${OFF}`;
  console.log(
    `${head}HTTP ${result.status}  raw ${kb(result.rawBytes).padStart(7)}  ` +
      `extracted ${n(result.text.length).padStart(8)} chars  ${verdict}`,
  );
  if (result.redirects > 0) console.log(`${' '.repeat(20)}${DIM}${result.redirects} redirect(s) → ${result.url}${OFF}`);
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.url === '') {
    console.error('usage: npm run probe -- <url> [--sessions sessions.json] [--out article.html]');
    return 2;
  }

  let target: URL;
  try {
    target = new URL(args.url);
  } catch {
    console.error(`${RED}Not a URL: ${args.url}${OFF}`);
    return 2;
  }

  // Offline mode: reduce a page you already have. Useful for a fixture, and for a page
  // only your own browser can reach — save it, then run the same pipeline over it.
  if (args.file !== null) {
    const html = await readFile(args.file, 'utf8');
    console.log('');
    console.log(`${BOLD}${args.file}${OFF} ${DIM}as ${target.hostname}${OFF}`);
    console.log('');
    const result = extractFromHtml(html, target.toString());
    report('from file', result);
    console.log('');
    if (result.ok) {
      console.log(`  ${DIM}${result.title ?? '(no title)'}${result.byline !== null ? ` — ${result.byline}` : ''}${OFF}`);
      if (args.show > 0) console.log(`  ${DIM}${result.text.slice(0, args.show).replace(/\s+/g, ' ')}…${OFF}`);
      if (args.out !== null) {
        await writeFile(args.out, result.html, 'utf8');
        console.log(`\n  wrote ${args.out}`);
      }
    }
    console.log('');
    return result.ok ? 0 : 1;
  }

  const sessions = await loadSessions(args.sessions);
  const cookie = cookieHeaderFor(target, sessions);

  console.log('');
  console.log(`${BOLD}${target.hostname}${OFF} ${DIM}${target.pathname}${OFF}`);
  if (cookie === null) {
    console.log(`${DIM}no stored session for this host (${args.sessions})${OFF}`);
  } else {
    console.log(`${DIM}session: ${cookieNames(cookie).length} cookies — ${cookieNames(cookie).join(', ')}${OFF}`);
  }
  console.log('');

  let anon: ExtractResult | null = null;
  let auth: ExtractResult | null = null;

  if (!args.authOnly) {
    anon = await extract(target.toString());
    report('anonymous', anon);
  }
  if (!args.anonOnly && cookie !== null) {
    // Serial, with SanFeedBin's ~250ms courtesy delay between fetches.
    await new Promise((resolve) => setTimeout(resolve, 250));
    auth = await extract(target.toString(), { cookie });
    report('with session', auth);
  }

  console.log('');

  const anonChars = anon?.ok === true ? anon.text.length : 0;
  const authChars = auth?.ok === true ? auth.text.length : 0;

  if (auth !== null && anon !== null) {
    if (authChars > anonChars * 1.5 && authChars > 0) {
      console.log(`  ${GREEN}→ The session is doing the work here${OFF} — ${n(authChars - anonChars)} more characters.`);
    } else if (anonChars > 0 && anon?.ok === true && !anon.truncation.truncated) {
      console.log(`  ${DIM}→ Anonymous extraction was already complete. No session needed for this one.${OFF}`);
    } else if (authChars <= anonChars) {
      console.log(`  ${YELLOW}→ The session changed nothing.${OFF} Either it has expired, or this page needs`);
      console.log(`    JavaScript to render its body — which no amount of cookies will fix.`);
    }
  } else if (anon?.ok === true && anon.truncation.truncated) {
    console.log(`  ${YELLOW}→ Truncated, and no session stored for ${target.hostname}.${OFF}`);
    console.log(`    Add one to ${args.sessions} and re-run — see docs/COOKIE_SETUP.md.`);
  }

  const best = auth?.ok === true ? auth : anon?.ok === true ? anon : null;

  if (best !== null && args.show > 0) {
    console.log('');
    console.log(`  ${DIM}${best.title ?? '(no title)'}${best.byline !== null ? ` — ${best.byline}` : ''}${OFF}`);
    console.log(`  ${DIM}${best.text.slice(0, args.show).replace(/\s+/g, ' ')}…${OFF}`);
  }

  if (best !== null && args.out !== null) {
    await writeFile(args.out, best.html, 'utf8');
    console.log('');
    console.log(`  wrote ${args.out}`);
  }

  console.log('');
  return best === null ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error);
    process.exit(1);
  },
);
