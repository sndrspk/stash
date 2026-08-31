#!/usr/bin/env tsx
/**
 * Manage publisher sessions without hand-editing a file.
 *
 *   npm run session -- add <host>      read a Cookie: header from stdin and store it
 *   npm run session -- list            hosts and cookie names — never values
 *   npm run session -- remove <host>   forget one host
 *
 * `add` never takes the header as an argument, so it stays out of your shell history:
 *
 *   npm run session -- add www.ft.com                  # paste at the prompt, press Enter
 *   pbpaste | npm run session -- add www.ft.com        # macOS, from the clipboard
 *   npm run session -- add www.ft.com --from head.txt  # from a file
 *
 * This is the local stand-in for the settings screen in Phase 7b. Same rules: values go
 * in, only names come out.
 */

import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { coerceHost, cookieNames, mergeCookieHeaders, parseCookieInput, serializeCookies } from '../src/lib/cookies.js';
import { DEFAULT_STORE_PATHS, loadSessionStore, saveSessionStore, SessionStoreError } from '../src/lib/session-store.js';

const BOLD = '[1m';
const DIM = '[2m';
const RED = '[31m';
const GREEN = '[32m';
const YELLOW = "\u001b[33m";
const OFF = '[0m';

const USAGE = `usage:
  npm run session -- add <host>       store a Cookie: header read from stdin
  npm run session -- list             show stored hosts and cookie names
  npm run session -- remove <host>    forget one host

options:
  --from <path>   read the header from a file instead of the terminal
  --file <path>   store to use (default: ${DEFAULT_STORE_PATHS[0]}, falling back to ${DEFAULT_STORE_PATHS[1]})`;

/**
 * Read the header.
 *
 * Interactively this takes a single line and ends at Enter. The obvious implementation —
 * read stdin to EOF — requires Ctrl-D, and Ctrl-D only signals EOF at the start of an
 * empty line: after pasting a header with no trailing newline it flushes the buffer and
 * the program keeps waiting, looking hung. A cookie header is one line, so read one line.
 *
 * Piped input is still read to EOF, since there is no terminal to end a line.
 */
async function readHeader(): Promise<string> {
  if (process.stdin.isTTY !== true) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8');
  }

  // Prompt on stderr so stdout stays clean if the caller is capturing it.
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(`${DIM}Paste the Cookie: header value, then press Enter.${OFF}\n`);
  } finally {
    rl.close();
  }
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  let file: string | null = null;
  let from: string | null = null;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--file') file = argv[++i] ?? null;
    else if (argv[i] === '--from') from = argv[++i] ?? null;
    else if (argv[i] !== undefined) positional.push(argv[i] as string);
  }

  const [command, hostArg] = positional;
  if (command === undefined) {
    console.error(USAGE);
    return 2;
  }

  const loaded = await loadSessionStore(file);
  const store = loaded.store;
  const target = file ?? loaded.path ?? DEFAULT_STORE_PATHS[0];

  // A store we could not read is a warning, never a blocker — least of all for the
  // command that exists to write a good one.
  for (const problem of loaded.problems) {
    console.error(`${YELLOW}${problem}${OFF}\n`);
  }

  if (command === 'list') {
    const hosts = Object.keys(store).sort();
    if (hosts.length === 0) {
      console.log(`${DIM}No sessions stored${loaded.path !== null ? ` in ${loaded.path}` : ''}.${OFF}`);
      return 0;
    }
    console.log(`${DIM}${loaded.path}${OFF}`);
    for (const host of hosts) {
      const names = cookieNames(store[host] ?? '');
      console.log(`  ${BOLD}${host}${OFF}  ${DIM}${names.length} cookies — ${names.join(', ')}${OFF}`);
    }
    return 0;
  }

  if (hostArg === undefined) {
    console.error(`${RED}${command} needs a host.${OFF}\n\n${USAGE}`);
    return 2;
  }
  const host = coerceHost(hostArg);
  if (host === null) {
    console.error(`${RED}"${hostArg}" is not a hostname.${OFF}`);
    console.error(`${DIM}Pass the host, or any URL on it:${OFF}`);
    console.error(`${DIM}  npm run session -- ${command} www.nieuwsblad.be${OFF}`);
    console.error(`${DIM}  npm run session -- ${command} https://www.nieuwsblad.be/cnt/article${OFF}`);
    return 2;
  }

  if (command === 'remove') {
    if (store[host] === undefined) {
      console.error(`${RED}No session stored for ${host}.${OFF}`);
      return 1;
    }
    delete store[host];
    await saveSessionStore(store, target);
    console.log(`${GREEN}Removed${OFF} ${host} from ${target}.`);
    return 0;
  }

  if (command !== 'add') {
    console.error(`${RED}Unknown command "${command}".${OFF}\n\n${USAGE}`);
    return 2;
  }

  const pasted = from !== null ? await readFile(from, 'utf8') : await readHeader();
  const parsed = parseCookieInput(pasted);

  if (parsed.format === 'empty') {
    console.error(`${RED}Nothing to store — the input was empty.${OFF}`);
    console.error('');
    if (from !== null) {
      console.error(`${from} is empty.`);
    } else if (process.stdin.isTTY === true) {
      console.error('Nothing was pasted. Some terminals need a moment for a long paste —');
      console.error('wait until the whole header appears, then press Enter.');
    } else {
      console.error('If you piped from the clipboard, it no longer holds the cookie header —');
      console.error('copying anything else since replaces it. Try one of these instead:');
      console.error('');
      console.error(`  ${BOLD}npm run session -- add ${host}${OFF}                 paste at the prompt, press Enter`);
      console.error(`  ${BOLD}npm run session -- add ${host} --from head.txt${OFF}  from a file`);
    }
    console.error('');
    console.error(`${DIM}Where to find the header: docs/COOKIE_SETUP.md${OFF}`);
    return 1;
  }

  if (parsed.format === 'unrecognised') {
    console.error(`${RED}That doesn't look like a Cookie: header${OFF} — stdin held ${parsed.hint}.`);
    console.error('');
    console.error('You want the value of the "cookie" REQUEST header:');
    console.error(`  DevTools → ${BOLD}Network${OFF} → reload → click the first (document) request`);
    console.error(`  → Headers → Request Headers → right-click ${BOLD}cookie${OFF} → Copy value`);
    console.error('');
    console.error(`${DIM}Not the Application → Cookies panel, though a paste from there also works.${OFF}`);
    console.error(`${DIM}See docs/COOKIE_SETUP.md.${OFF}`);
    return 1;
  }

  if (parsed.format === 'table') {
    console.error(`${YELLOW}That looks like a pasted cookie table rather than a header — reading it anyway.${OFF}`);
    console.error('');
  }

  // Merging rather than replacing: a partial paste must not silently drop cookies that
  // were already there.
  const existing = store[host] ?? '';
  store[host] = mergeCookieHeaders(existing, serializeCookies(parsed.cookies));

  await saveSessionStore(store, target);
  const names = cookieNames(store[host] ?? '');
  console.log(`${GREEN}Stored${OFF} ${names.length} cookies for ${BOLD}${host}${OFF} in ${target}.`);
  console.log(`${DIM}${names.join(', ')}${OFF}`);
  console.log('');
  if (loaded.problems.length > 0) {
    console.log(`${DIM}The unreadable file above is no longer used — you can delete it.${OFF}`);
  }
  console.log(`Now try:  npm run probe -- https://${host}/some-paywalled-article`);
  return 0;
}

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
