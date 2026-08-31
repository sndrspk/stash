#!/usr/bin/env tsx
/**
 * Manage publisher sessions without hand-editing a file.
 *
 *   npm run session -- add <host>      read a Cookie: header from stdin and store it
 *   npm run session -- list            hosts and cookie names — never values
 *   npm run session -- remove <host>   forget one host
 *
 * `add` reads stdin, so the header never lands in your shell history:
 *
 *   pbpaste | npm run session -- add www.ft.com        # macOS
 *   npm run session -- add www.ft.com                  # then paste, then Ctrl-D
 *
 * This is the local stand-in for the settings screen in Phase 7b. Same rules: values go
 * in, only names come out.
 */

import { cookieNames, mergeCookieHeaders, normalizeHost, parseCookieHeader } from '../src/lib/cookies.js';
import { DEFAULT_STORE_PATHS, loadSessionStore, saveSessionStore, SessionStoreError } from '../src/lib/session-store.js';

const BOLD = '[1m';
const DIM = '[2m';
const RED = '[31m';
const GREEN = '[32m';
const OFF = '[0m';

const USAGE = `usage:
  npm run session -- add <host>       store a Cookie: header read from stdin
  npm run session -- list             show stored hosts and cookie names
  npm run session -- remove <host>    forget one host

options:
  --file <path>   store to use (default: ${DEFAULT_STORE_PATHS[0]}, falling back to ${DEFAULT_STORE_PATHS[1]})`;

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY === true) {
    console.error(`${DIM}Paste the Cookie: header value, then press Ctrl-D.${OFF}`);
  }
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString('utf8');
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  let file: string | null = null;
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--file') file = argv[++i] ?? null;
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
  const host = normalizeHost(hostArg);
  if (host === '') {
    console.error(`${RED}"${hostArg}" is not a host.${OFF}`);
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

  const pasted = await readStdin();
  const parsed = parseCookieHeader(pasted);
  if (parsed.size === 0) {
    console.error(`${RED}That doesn't look like a Cookie: header — no name=value pairs found.${OFF}`);
    console.error(`${DIM}Copy the value of the "cookie" REQUEST header, not the cookie storage panel.${OFF}`);
    console.error(`${DIM}See docs/COOKIE_SETUP.md.${OFF}`);
    return 1;
  }

  // Merging rather than replacing: a partial paste must not silently drop cookies that
  // were already there.
  const existing = store[host] ?? '';
  store[host] = mergeCookieHeaders(existing, pasted);

  await saveSessionStore(store, target);
  const names = cookieNames(store[host] ?? '');
  console.log(`${GREEN}Stored${OFF} ${names.length} cookies for ${BOLD}${host}${OFF} in ${target}.`);
  console.log(`${DIM}${names.join(', ')}${OFF}`);
  console.log('');
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
