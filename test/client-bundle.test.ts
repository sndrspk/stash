import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import { code } from './source-scan';

/*
 * Server-only libraries must not be reachable from the client entry.
 *
 * `linkedom` exists to give a serverless function a DOM. A browser has one. But a
 * bundler follows a module's *imports*, not the export you asked for, so a single
 * `import { removeFurniture } from '../lib/cleaners'` in `Reader.tsx` — one
 * function that never touched linkedom — pulled linkedom and its parser stack
 * (htmlparser2, css-select, cssom, domutils, css-what) into the client bundle:
 * about 470 KiB unminified, shipped to a phone to do what `DOMParser` does for
 * free. It is why the bundle tripped Vite's 500 kB chunk warning.
 *
 * Nothing failed. That is what makes it worth a test rather than a comment: the
 * app worked perfectly, the suite passed, and the only symptom was a warning in a
 * deploy log that reads like boilerplate. The next person to import a convenient
 * helper from `cleaners.ts` would put it straight back, and the same warning would
 * scroll past again.
 *
 * This walks the real import graph rather than grepping `dist/`, so it runs in the
 * ordinary suite with no build step, and it names the path that reintroduced the
 * dependency instead of just reporting that something did.
 */
const ENTRY = 'src/main.tsx';

/**
 * Specifiers that mean "this module expects to be on a server".
 *
 * The three packages are no longer installed — they went with Stash's own fetching —
 * and the entries stay as a guard against reintroduction, which costs nothing and is
 * the cheaper half of this list.
 *
 * `node:` is the half that is still live. `src/lib/fetch-guard.ts` imports
 * `node:dns/promises` to resolve and vet every outbound address, and it sits in
 * `src/lib` alongside modules the client uses every render, so the wrong import is one
 * autocomplete away — and it would be a build that fails or a runtime that throws
 * rather than merely dead weight. The prefix catches every builtin at once, which is
 * the right shape here: the rule is "the client has no Node", not "the client has no
 * DNS".
 */
const SERVER_ONLY = ['linkedom', '@mozilla/readability', 'ioredis', 'node:'];

const EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx'];

/** Matches the specifier of any static or dynamic import, and of a re-export. */
const IMPORT = /(?:from|import)\s*\(?\s*['"]([^'"]+)['"]/g;

/**
 * Relative specifiers only — a bare specifier is the package we are looking for,
 * not a file to descend into.
 *
 * `src/lib` writes `./truncation.js` because those modules run as real Node ESM
 * (see `module-resolution.test.ts`), while client code writes `../lib/db` and lets
 * Vite resolve it. Both shapes point at a `.ts` file on disk, so the `.js` is
 * swapped back before looking.
 */
function resolveLocal(fromFile: string, specifier: string): string | null {
  const base = resolve(dirname(fromFile), specifier);
  const candidates = [base.replace(/\.js$/, '.ts'), base.replace(/\.js$/, '.tsx'), base];
  for (const candidate of candidates) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  for (const extension of EXTENSIONS) {
    if (existsSync(base + extension)) return base + extension;
    const index = join(base, `index${extension}`);
    if (existsSync(index)) return index;
  }
  return null;
}

interface Reach {
  /** How the package was reached, entry first. */
  path: string[];
  package: string;
}

function walk(entry: string): { found: Reach[]; visited: Set<string> } {
  const found: Reach[] = [];
  const visited = new Set<string>();

  const visit = (file: string, trail: string[]): void => {
    if (visited.has(file)) return;
    visited.add(file);

    const here = [...trail, relative(process.cwd(), file)];
    for (const [, specifier] of code(readFileSync(file, 'utf8')).matchAll(IMPORT)) {
      if (specifier === undefined) continue;

      if (specifier.startsWith('.')) {
        const next = resolveLocal(file, specifier);
        if (next !== null) visit(next, here);
        continue;
      }

      // A bare specifier: the package itself, or a subpath of it.
      const owner = SERVER_ONLY.find((name) =>
        // `node:` is a prefix rather than a package name, so it matches on its own
        // terms; the rest match exactly or as a subpath.
        name.endsWith(':')
          ? specifier.startsWith(name)
          : specifier === name || specifier.startsWith(`${name}/`),
      );
      if (owner !== undefined) found.push({ path: here, package: owner });
    }
  };

  visit(resolve(entry), []);
  return { found, visited };
}

describe('client bundle', () => {
  const { found: reached, visited } = walk(ENTRY);

  it('starts from an entry that actually exists', () => {
    // Guards against a rename turning this suite into one that passes vacuously.
    expect(existsSync(resolve(ENTRY))).toBe(true);
  });

  it('reaches enough modules to be looking at the real graph', () => {
    // The same guard from the other side, and the one that matters more: a
    // resolver that quietly resolved nothing would find no server-only imports
    // and read as success. A false negative here is invisible; a false positive
    // is a failing test with a path in it.
    expect(visited.size).toBeGreaterThan(20);
  });

  it.each(SERVER_ONLY)('does not reach %s', (name) => {
    const offenders = reached.filter((hit) => hit.package === name);
    const trails = offenders.map((hit) => hit.path.join('\n    → ')).join('\n\n  ');

    expect(
      offenders,
      `${name} is reachable from ${ENTRY} and will be bundled into the client:\n\n  ${trails}\n\n` +
        'The browser has its own DOM. Server-side parsing belongs in api/ or in a ' +
        'module the client never imports — see src/lib/furniture.ts, which is the ' +
        'render-time half of cleaners.ts split out for exactly this reason.',
    ).toEqual([]);
  });
});
