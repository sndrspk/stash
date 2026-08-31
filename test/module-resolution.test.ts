import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/*
 * Relative imports in server-side code must carry a `.js` extension.
 *
 * `package.json` declares `"type": "module"`, so the serverless functions run as
 * real Node ESM, where extensionless relative specifiers do not resolve. Nothing
 * local catches this: Vite resolves them for the client, Vitest resolves them for
 * these tests, and `vercel dev` resolves them too. Only the built deployment fails,
 * and it fails as `FUNCTION_INVOCATION_FAILED` — a 500 with no mention of imports.
 *
 * That is exactly how `/api/status` shipped broken while `/api/health`, which
 * imports nothing, worked fine and made the deployment look healthy.
 *
 * Client code under src/routes, src/components and src/hooks is exempt: Vite
 * bundles it and never hands it to Node.
 */
const SERVER_DIRS = ['api', 'src/lib'];

/** Matches the specifier of any static or dynamic relative import. */
const RELATIVE_IMPORT = /(?:from|import)\s*\(?\s*['"](\.[^'"]*)['"]/g;

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return entry.isFile() && /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe('server-side module resolution', () => {
  const files = SERVER_DIRS.flatMap(sourceFiles);

  it('finds the server source files', () => {
    // Guards against the glob silently matching nothing and the suite passing
    // vacuously.
    expect(files.length).toBeGreaterThan(8);
  });

  it.each(files)('%s uses .js extensions on relative imports', (file) => {
    const source = readFileSync(file, 'utf8');
    const offenders: string[] = [];

    for (const [, specifier] of source.matchAll(RELATIVE_IMPORT)) {
      if (specifier && !specifier.endsWith('.js')) offenders.push(specifier);
    }

    expect(
      offenders,
      `${file} imports ${offenders.join(', ')} without a .js extension. ` +
        'Node ESM will not resolve these at runtime, and the function will return ' +
        'FUNCTION_INVOCATION_FAILED once deployed — but everything will look fine locally.',
    ).toEqual([]);
  });
});
