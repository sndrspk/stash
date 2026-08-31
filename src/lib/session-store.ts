/**
 * Reading and writing the local session store.
 *
 * A `Cookie:` header is a hostile thing to paste into JSON: it is long, it contains
 * quotes and backslashes that need escaping, and copying it out of DevTools routinely
 * drags in a newline — which JSON rejects outright with an unhelpful byte offset. So the
 * primary format is line-based text, where none of that can go wrong:
 *
 *     # one host per line
 *     www.ft.com   FTSession=abc; FTUser=def
 *     www.nrc.nl = nrc_session=xyz
 *
 * JSON is still accepted, so an existing sessions.json keeps working.
 *
 * This is the local stand-in for Phase 7b's encrypted KV store. Same shape, no crypto —
 * which is exactly why the file is git-ignored.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { stripControlChars, type SessionStore } from './cookies.js';

export const DEFAULT_STORE_PATHS = ['sessions.txt', 'sessions.json'] as const;

export class SessionStoreError extends Error {}

/**
 * Parse the line-based format. The first whitespace or `=`, whichever comes first, ends
 * the host — hostnames can contain neither, and cookie headers contain both, so this is
 * unambiguous in a way that splitting on every `=` is not.
 */
export function parseSessionText(text: string): SessionStore {
  const store: SessionStore = {};
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;

    const space = line.search(/\s/);
    const equals = line.indexOf('=');
    const candidates = [space, equals].filter((i) => i > 0);
    if (candidates.length === 0) continue; // a bare host with no cookies: nothing to store
    const cut = Math.min(...candidates);

    const host = line.slice(0, cut).trim();
    const value = line
      .slice(cut)
      .replace(/^[\s=]+/, '')
      .trim();
    if (host === '' || value === '') continue;
    store[host] = stripControlChars(value);
  }
  return store;
}

/** Render a store back to the line-based format, with a header comment. */
export function formatSessionText(store: SessionStore): string {
  const lines = [
    '# Stash publisher sessions — one host per line, then its Cookie: header value.',
    '# These are credentials for your subscriptions. This file is git-ignored; keep it that way.',
    '# Managed by `npm run session`. See SESSIONS.md.',
    '',
  ];
  for (const host of Object.keys(store).sort()) {
    const value = store[host];
    if (value !== undefined && value.trim() !== '') lines.push(`${host} ${value}`);
  }
  return `${lines.join('\n')}\n`;
}

function parseSessionJson(text: string, path: string): SessionStore {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new SessionStoreError(
      `Ignoring ${path}: it is not valid JSON (${detail}).\n` +
        'A pasted cookie header usually breaks JSON — an embedded newline, a quote, a backslash.\n' +
        `Sessions now live in ${DEFAULT_STORE_PATHS[0]}, which has none of those problems, so this ` +
        `file is no longer used.\nOnce your sessions are stored there you can delete ${path}.`,
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new SessionStoreError(`${path} must be a JSON object of host → cookie header.`);
  }

  const store: SessionStore = {};
  for (const [host, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (typeof value !== 'string') {
      throw new SessionStoreError(`${path}: the value for "${host}" must be a string.`);
    }
    store[host] = stripControlChars(value);
  }
  return store;
}

/** Parse either format, chosen by extension. */
export function parseSessionStore(text: string, path: string): SessionStore {
  return path.endsWith('.json') ? parseSessionJson(text, path) : parseSessionText(text);
}

export interface LoadedStore {
  store: SessionStore;
  /** The file actually read, or null when none of the candidates could be used. */
  path: string | null;
  /** Files that exist but could not be read or parsed. Warn; never fail on these. */
  problems: string[];
}

/**
 * Load the first usable store. A missing file is not an error — running the probe with
 * no sessions at all is the expected first step.
 *
 * A file that exists but cannot be parsed is also not fatal. SanFeedBin's storage layer
 * recovers from a corrupt blob rather than crashing, and the same applies here for a
 * sharper reason: a store too broken to read must not block the very command that would
 * write a good one. So a bad candidate is reported and skipped, never thrown — and never
 * deleted or overwritten either, since it is the caller's data to keep.
 */
export async function loadSessionStore(explicitPath?: string | null): Promise<LoadedStore> {
  const candidates =
    explicitPath !== undefined && explicitPath !== null ? [explicitPath] : [...DEFAULT_STORE_PATHS];
  const problems: string[] = [];

  for (const path of candidates) {
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      problems.push(`Could not read ${path}: ${(error as Error).message}`);
      continue;
    }
    try {
      return { store: parseSessionStore(text, path), path, problems };
    } catch (error) {
      problems.push(error instanceof SessionStoreError ? error.message : String(error));
    }
  }

  return { store: {}, path: null, problems };
}

export async function saveSessionStore(store: SessionStore, path: string): Promise<void> {
  if (path.endsWith('.json')) {
    await writeFile(path, `${JSON.stringify(store, null, 2)}\n`, 'utf8');
    return;
  }
  await writeFile(path, formatSessionText(store), 'utf8');
}
