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
 *   --sessions <file>   session store (default: sessions.txt, then sessions.json)
 *   --anon-only         skip the authenticated attempt
 *   --auth-only         skip the anonymous attempt
 *   --file <path>       reduce a saved HTML file instead of fetching (no network)
 *   --out <file>        write the extracted article HTML for eyeballing
 *   --show <n>          print the first n characters of extracted text (default 300)
 *   --ua <string>       User-Agent to send (default: STASH_USER_AGENT, else Stash/0.1)
 *   --raw <file>        save the publisher's HTML exactly as sent, before extraction
 *
 * Cookie VALUES are never printed. Names only — the same rule the real app follows.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { cookieHeaderFor, cookieNames } from '../src/lib/cookies.js';
import { parseHTML } from 'linkedom';
import { extract, extractFromHtml, type ExtractResult } from '../src/lib/extract.js';
import { configuredUserAgent, guardedFetch, USER_AGENT } from '../src/lib/fetch-guard.js';
import {
  DEFAULT_STORE_PATHS,
  loadSessionStore,
  SessionStoreError,
} from '../src/lib/session-store.js';

const BOLD = '[1m';
const DIM = '[2m';
const RED = '[31m';
const GREEN = '[32m';
const YELLOW = '[33m';
const OFF = '[0m';

interface Args {
  url: string;
  userAgent: string | null;
  raw: string | null;
  sessions: string | null;
  anonOnly: boolean;
  authOnly: boolean;
  file: string | null;
  out: string | null;
  show: number;
}

function parseArgs(argv: string[]): Args {
  const args: Args = {
    url: '',
    userAgent: null,
    raw: null,
    sessions: null,
    anonOnly: false,
    authOnly: false,
    file: null,
    out: null,
    show: 300,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--raw') args.raw = argv[++i] ?? null;
    else if (arg === '--ua') args.userAgent = argv[++i] ?? args.userAgent;
    else if (arg === '--sessions') args.sessions = argv[++i] ?? args.sessions;
    else if (arg === '--file') args.file = argv[++i] ?? null;
    else if (arg === '--out') args.out = argv[++i] ?? null;
    else if (arg === '--show') args.show = Number(argv[++i] ?? args.show);
    else if (arg === '--anon-only') args.anonOnly = true;
    else if (arg === '--auth-only') args.authOnly = true;
    else if (arg !== undefined && !arg.startsWith('-') && args.url === '') args.url = arg;
  }
  return args;
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
  if (result.redirects > 0)
    console.log(`${' '.repeat(20)}${DIM}${result.redirects} redirect(s) → ${result.url}${OFF}`);
}

/**
 * The User-Agent for this run, if one was asked for.
 *
 * Present so a string can be tried against a live publisher without a deploy: a 403
 * costs one command here and a redeploy there, and the difference decides whether
 * anyone iterates at all.
 */
function userAgentOption(args: Args): { userAgent?: string } {
  return args.userAgent === null ? {} : { userAgent: args.userAgent };
}

/** `div.article-body#main`, near enough — enough to find it in the file by eye. */
function describeElement(element: Element): string {
  const tag = element.tagName.toLowerCase();
  const id = element.id === '' ? '' : `#${element.id}`;
  const cls = element.getAttribute('class');
  const classes =
    cls === null || cls.trim() === '' ? '' : `.${cls.trim().split(/\s+/).slice(0, 3).join('.')}`;
  return `${tag}${id}${classes}`;
}

/**
 * Which containers hold the prose, and how much?
 *
 * This is the number that decides the whole question, and the first census left it out.
 * A page can be 80% markup and still have no article in it — navigation, menus and
 * footers are markup too. What separates "the article was never sent" from "Readability
 * scored the wrong container" is how much *visible prose* the document holds against how
 * much came out of the extractor.
 *
 * Reported per container rather than as one total, because a total cannot distinguish a
 * page with one long article from a page with forty teasers, and those look identical
 * until you see the shape. Elements with at least two direct `<p>` children are what
 * Readability itself scores, so listing the fattest few names the container it should
 * have picked — which is a starting point for a fix rather than just a verdict.
 */
function describeProse(document: Document, extracted: number | null): void {
  for (const node of [...document.querySelectorAll('script, style, noscript')]) node.remove();

  const visible = (document.body?.textContent ?? '').replace(/\s+/g, ' ').trim();

  const candidates: { label: string; chars: number; paragraphs: number }[] = [];
  for (const element of document.querySelectorAll('*')) {
    const paragraphs = [...element.children].filter((c) => c.tagName.toLowerCase() === 'p');
    if (paragraphs.length < 2) continue;
    const chars = paragraphs.reduce(
      (total, p) => total + (p.textContent ?? '').replace(/\s+/g, ' ').trim().length,
      0,
    );
    if (chars > 0)
      candidates.push({ label: describeElement(element), chars, paragraphs: paragraphs.length });
  }
  candidates.sort((a, b) => b.chars - a.chars);

  console.log(
    `    ${n(visible.length)} chars of visible text in the document` +
      (extracted === null ? '' : ` ${DIM}(extractor found ${n(extracted)})${OFF}`),
  );
  if (candidates.length === 0) {
    console.log(
      `    ${DIM}no container with two or more paragraphs — there is no prose here${OFF}`,
    );
    return;
  }
  console.log(`    ${DIM}fattest paragraph containers:${OFF}`);
  for (const c of candidates.slice(0, 3)) {
    console.log(
      `      ${n(c.chars).padStart(7)} chars in ${c.paragraphs} <p>  ${DIM}${c.label}${OFF}`,
    );
  }
}

/** Recursively find the longest `articleBody` anywhere in a parsed JSON-LD value. */
function longestArticleBody(value: unknown): string | null {
  if (Array.isArray(value)) {
    let best: string | null = null;
    for (const item of value) {
      const found = longestArticleBody(item);
      if (found !== null && (best === null || found.length > best.length)) best = found;
    }
    return best;
  }
  if (value === null || typeof value !== 'object') return null;

  let best: string | null = null;
  for (const [key, child] of Object.entries(value)) {
    const found =
      key === 'articleBody' && typeof child === 'string' ? child : longestArticleBody(child);
    if (found !== null && (best === null || found.length > best.length)) best = found;
  }
  return best;
}

/**
 * What is actually in the page the publisher sent?
 *
 * A 200 with 183 KB of HTML and a 300-character extraction has two very different
 * explanations, and the difference decides whether anything can be done about it. Either
 * the article is genuinely not there — fetched by script after load, which is the
 * ceiling `docs/EXTRACTION.md` describes — or it *is* there, in a form Readability does
 * not read: a JSON-LD `articleBody`, or a framework's hydration payload. The second is a
 * publisher-agnostic extraction improvement waiting to be made; the first is not fixable
 * at all. Guessing between them wastes an afternoon, so count instead.
 *
 * Signals only, no publisher names: paragraph markup, JSON-LD, and the two hydration
 * shapes common enough to be worth naming (`__NEXT_DATA__`, streamed `self.__next_f`).
 */
function describeRaw(html: string, extracted: number | null = null): void {
  const paragraphs = (html.match(/<p[\s>]/gi) ?? []).length;
  const scriptBytes = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].reduce(
    (total, m) => total + (m[1]?.length ?? 0),
    0,
  );

  console.log(`  ${BOLD}what the page contains${OFF}`);
  console.log(
    `    ${n(paragraphs)} <p> element(s), ${kb(scriptBytes)} of inline script ` +
      `${DIM}(${Math.round((scriptBytes / Math.max(html.length, 1)) * 100)}% of the page)${OFF}`,
  );

  const blocks = [
    ...html.matchAll(
      /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
    ),
  ];
  let body: string | null = null;
  let unparseable = 0;
  for (const block of blocks) {
    try {
      const found = longestArticleBody(JSON.parse(block[1] ?? ''));
      if (found !== null && (body === null || found.length > body.length)) body = found;
    } catch {
      unparseable += 1;
    }
  }
  const ldNote = unparseable > 0 ? ` ${DIM}(${unparseable} did not parse)${OFF}` : '';
  if (body !== null) {
    console.log(
      `    ${GREEN}JSON-LD articleBody present${OFF}: ${n(body.length)} chars ` +
        `in ${blocks.length} ld+json block(s)${ldNote}`,
    );
    console.log(`    ${DIM}${body.slice(0, 200).replace(/\s+/g, ' ')}…${OFF}`);
  } else {
    console.log(`    ${blocks.length} ld+json block(s), no articleBody in any${ldNote}`);
  }

  const hydration: string[] = [];
  if (html.includes('__NEXT_DATA__')) hydration.push('__NEXT_DATA__');
  if (html.includes('self.__next_f')) hydration.push('self.__next_f (streamed)');
  console.log(
    hydration.length > 0
      ? `    hydration payload: ${hydration.join(', ')}`
      : `    no recognised hydration payload`,
  );

  // Last, and destructive to the parsed tree — it strips script and style to count what
  // a reader would see. Nothing below may use the document afterwards.
  describeProse(parseHTML(html).document as unknown as Document, extracted);
}

/** A refusal the publisher issued deliberately, rather than a transport failure. */
function isRefusal(result: ExtractResult | null): boolean {
  return result !== null && !result.ok && /^HTTP (401|403|429|451)$/.test(result.tag);
}

function addSessionHint(host: string): void {
  console.log(`    ${DIM}npm run session -- add ${host}${OFF}   ${DIM}(see SESSIONS.md)${OFF}`);
}

/**
 * What to try after a refusal — which depends entirely on what was already tried.
 *
 * This used to print one fixed paragraph advising a browser User-Agent, and printed it
 * verbatim to a run that had *just* been given one with `--ua`. Advice to try the thing
 * you have already done is worse than no advice: it reads as though the tool inspected
 * the run and concluded nothing had changed, when in fact it never looked.
 *
 * So it takes the User-Agent that actually went out. With the honest default there is a
 * cheap thing left to try and a posture decision attached to it; with a browser string
 * already sent, the refusal is not about how the request introduces itself, and saying so
 * is the useful half.
 */
function botProtectionHint(userAgent: string): void {
  console.log(`    This is the anti-bot case in docs/EXTRACTION.md: a challenge page needs a`);
  console.log(`    browser to answer it, and no cookie will substitute.`);
  if (userAgent === USER_AGENT) {
    console.log(
      `    Stash sent its honest ${DIM}Stash/0.1${OFF} User-Agent, and some publishers refuse`,
    );
    console.log(`    anything that isn't browser-shaped. Trying a browser string is a deliberate`);
    console.log(`    choice, not a default — see the posture note at the end of`);
    console.log(`    docs/EXTRACTION.md before making it: ${DIM}--ua "<string>"${OFF}`);
    return;
  }
  console.log(`    A browser User-Agent was already sent, so this refusal is not about how the`);
  console.log(`    request introduces itself. Something else about it is being read — the TLS`);
  console.log(`    handshake and the header set both differ from a real browser's, and neither`);
  console.log(`    is something a fetch can dress up. A clearance cookie will not carry either:`);
  console.log(`    those are issued against the address and the User-Agent that earned them.`);
}

/**
 * Did the publisher treat the signed-in request differently at all?
 *
 * "The session changed nothing" used to be this script's verdict whenever the
 * authenticated extraction came back short, and it offered two explanations — expired
 * cookies, or a JavaScript-built body — as though nothing on hand could tell them apart.
 * Something could. A publisher that does not recognise a session sends an anonymous
 * visitor to a login host and serves everyone the same small page; one that does
 * recognise it skips the redirect and serves noticeably more HTML, even when the article
 * itself is still withheld. Both of those are in the results already.
 *
 * Returns the evidence rather than a boolean, because the number is what makes the
 * verdict checkable instead of something to take on trust.
 */
export function sessionRecognised(anon: ExtractResult, auth: ExtractResult): string | null {
  if (!auth.ok) return null;
  const redirected = 'Redirected to ';
  if (!anon.ok && anon.tag.startsWith(redirected)) {
    return `the anonymous fetch was sent to ${anon.tag.slice(redirected.length)} and this one was not`;
  }
  if (anon.ok && auth.rawBytes > anon.rawBytes * 1.5) {
    return `${kb(auth.rawBytes)} of HTML against ${kb(anon.rawBytes)} anonymous`;
  }
  return null;
}

function rawHint(): void {
  console.log(`    ${DIM}npm run probe -- <url> --raw page.html${OFF} counts what is in the page:`);
  console.log(`    a fat paragraph container beside a thin extraction means the article was sent`);
  console.log(`    and scored wrong, which is fixable. A thin one means it was never sent.`);
}

export function summarize(
  host: string,
  anon: ExtractResult | null,
  auth: ExtractResult | null,
  userAgent: string = USER_AGENT,
): void {
  const anonChars = anon?.ok === true ? anon.text.length : 0;
  const authChars = auth?.ok === true ? auth.text.length : 0;

  // Both attempts ran.
  if (anon !== null && auth !== null) {
    if (isRefusal(anon) && isRefusal(auth)) {
      console.log(`  ${RED}→ Refused both ways.${OFF}`);
      botProtectionHint(userAgent);
      return;
    }
    /*
     * Complete, and better than anonymous. Guarded on the truncation verdict, which the
     * old ordering left out: an authenticated 332 characters against a failed anonymous
     * fetch satisfied "more characters than anonymous" and was announced as the session
     * doing the work, while what was actually on screen was a subscription pitch.
     */
    if (auth.ok && !auth.truncation.truncated && (authChars > anonChars * 1.5 || !anon.ok)) {
      if (isRefusal(anon)) {
        console.log(
          `  ${GREEN}→ The session is not optional here${OFF} — ${host} refuses anonymous fetches`,
        );
        console.log(`    outright, and serves the article once you're signed in.`);
      } else {
        console.log(
          `  ${GREEN}→ The session is doing the work here${OFF} — ${n(authChars - anonChars)} more characters.`,
        );
      }
      return;
    }
    if (anon.ok && !anon.truncation.truncated) {
      console.log(
        `  ${DIM}→ Anonymous extraction was already complete. No session needed for this one.${OFF}`,
      );
      return;
    }

    const recognised = sessionRecognised(anon, auth);
    if (recognised !== null) {
      console.log(
        `  ${YELLOW}→ The session is being honoured, and the article still isn't here.${OFF}`,
      );
      console.log(`    ${DIM}${recognised}${OFF} — so this is not an expired session.`);
      console.log(`    What came back is the signed-in page without its body, which is the`);
      console.log(`    JavaScript case in docs/EXTRACTION.md. Confirm it rather than assume it:`);
      rawHint();
      return;
    }
    console.log(
      `  ${YELLOW}→ The session changed nothing${OFF}, and nothing here says it was recognised.`,
    );
    console.log(`    Most likely expired — re-paste it and run this again. If that changes`);
    console.log(`    nothing either, the body is not in the HTML:`);
    rawHint();
    return;
  }

  // Anonymous only: no session stored for this host.
  if (isRefusal(anon)) {
    console.log(
      `  ${YELLOW}→ ${host} refused the anonymous fetch, and no session is stored for it.${OFF}`,
    );
    console.log(`    That is expected for a publisher that gates articles. Add your session and`);
    console.log(`    re-run — this is exactly the case the paste step exists for:`);
    addSessionHint(host);
    return;
  }
  if (anon !== null && !anon.ok) {
    console.log(`  ${RED}→ Failed before extraction: ${anon.tag}.${OFF}`);
    return;
  }
  if (anon?.ok === true && anon.truncation.truncated) {
    console.log(`  ${YELLOW}→ Truncated, and no session stored for ${host}.${OFF}`);
    addSessionHint(host);
    return;
  }
  if (anon?.ok === true) {
    console.log(`  ${GREEN}→ Complete without a session.${OFF} Nothing to do for this publisher.`);
  }
}

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (args.url === '') {
    console.error('usage: npm run probe -- <url> [--sessions sessions.txt] [--out article.html]');
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
    // The same census as raw mode, because this is the other half of the same workflow:
    // a page the deployment cannot reach gets saved from a browser and reduced here, and
    // "why is the extraction short" is the question either way.
    describeRaw(html, result.ok ? result.text.length : null);
    console.log('');
    if (result.ok) {
      console.log(
        `  ${DIM}${result.title ?? '(no title)'}${result.byline !== null ? ` — ${result.byline}` : ''}${OFF}`,
      );
      if (args.show > 0)
        console.log(`  ${DIM}${result.text.slice(0, args.show).replace(/\s+/g, ' ')}…${OFF}`);
      if (args.out !== null) {
        await writeFile(args.out, result.html, 'utf8');
        console.log(`\n  wrote ${args.out}`);
      }
    }
    console.log('');
    return result.ok ? 0 : 1;
  }

  const loaded = await loadSessionStore(args.sessions);
  const cookie = cookieHeaderFor(target, loaded.store);
  const storeLabel = loaded.path ?? `no ${DEFAULT_STORE_PATHS[0]}`;

  for (const problem of loaded.problems) {
    console.error(`${YELLOW}${problem}${OFF}\n`);
  }

  console.log('');
  console.log(`${BOLD}${target.hostname}${OFF} ${DIM}${target.pathname}${OFF}`);
  if (cookie === null) {
    console.log(`${DIM}no stored session for this host (${storeLabel})${OFF}`);
  } else {
    console.log(
      `${DIM}session: ${cookieNames(cookie).length} cookies — ${cookieNames(cookie).join(', ')}${OFF}`,
    );
  }
  console.log('');

  /*
   * Raw mode: one fetch, no extraction, the bytes written out untouched.
   *
   * Deliberately its own mode rather than a side effect of the normal run. The question
   * it answers — is the article in what the server sent? — is about the response, and
   * mixing it into a run that fetches twice would leave it ambiguous which response was
   * saved. It replays the session when there is one, because the interesting page is
   * almost always the signed-in one.
   */
  if (args.raw !== null) {
    const response = await guardedFetch(target.toString(), {
      cookie,
      ...userAgentOption(args),
    });
    await writeFile(args.raw, response.body, 'utf8');
    console.log(
      `  ${BOLD}${'raw fetch'.padEnd(18)}${OFF}HTTP ${response.status}  ` +
        `${kb(response.bytes)}  ${response.redirects} redirect(s)`,
    );
    console.log(`${' '.repeat(20)}${DIM}final URL: ${response.url}${OFF}`);
    if (response.truncatedAtCap)
      console.log(`${' '.repeat(20)}${YELLOW}stopped at the size cap — the page is larger${OFF}`);
    console.log(`${' '.repeat(20)}${DIM}wrote ${args.raw}${OFF}`);
    console.log('');
    // Reduced too, though this mode is not about the extraction: it costs no second
    // fetch, and "how much prose is in there" only means something next to "how much
    // came out".
    const reduced = extractFromHtml(response.body, response.url, cookie !== null);
    describeRaw(response.body, reduced.ok ? reduced.text.length : null);
    console.log('');
    return response.status >= 200 && response.status < 300 ? 0 : 1;
  }

  let anon: ExtractResult | null = null;
  let auth: ExtractResult | null = null;

  if (!args.authOnly) {
    anon = await extract(target.toString(), userAgentOption(args));
    report('anonymous', anon);
  }
  if (!args.anonOnly && cookie !== null) {
    // Serial, with SanFeedBin's ~250ms courtesy delay between fetches.
    await new Promise((resolve) => setTimeout(resolve, 250));
    auth = await extract(target.toString(), { cookie, ...userAgentOption(args) });
    report('with session', auth);
  }

  console.log('');

  summarize(target.hostname, anon, auth, args.userAgent ?? configuredUserAgent());

  const best = auth?.ok === true ? auth : anon?.ok === true ? anon : null;

  if (best !== null && args.show > 0) {
    console.log('');
    console.log(
      `  ${DIM}${best.title ?? '(no title)'}${best.byline !== null ? ` — ${best.byline}` : ''}${OFF}`,
    );
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

/*
 * Only when run as a command. The verdict functions above are unit-tested, and importing
 * this file to reach them must not fire a network probe and call `process.exit` in the
 * middle of the suite.
 */
const invokedDirectly =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  main().then(
    (code) => process.exit(code),
    (error: unknown) => {
      if (error instanceof SessionStoreError) {
        console.error(`${RED}${error.message}${OFF}`);
        process.exit(1);
      }
      console.error(error);
      process.exit(1);
    },
  );
}
