import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { SECRET_VARS, findLeakedValues, findViteReferences } from '../scripts/verify-build';

async function fixture(files: Record<string, string>): Promise<string[]> {
  const dir = await mkdtemp(join(tmpdir(), 'stash-verify-'));
  const paths: string[] = [];
  for (const [name, contents] of Object.entries(files)) {
    const path = join(dir, name);
    await writeFile(path, contents, 'utf8');
    paths.push(path);
  }
  return paths;
}

describe('the list of secrets', () => {
  it('covers every variable that must never reach a browser', () => {
    /*
     * Listed by name rather than derived from the environment, so adding a secret and
     * forgetting to add it here is a visible omission in a diff. This test is the
     * reminder that the two lists have to be kept together.
     */
    expect([...SECRET_VARS]).toEqual([
      'INSTAPAPER_CONSUMER_KEY',
      'INSTAPAPER_CONSUMER_SECRET',
      'INSTAPAPER_OAUTH_TOKEN',
      'INSTAPAPER_OAUTH_TOKEN_SECRET',
      'STASH_PASSPHRASE',
      'STASH_ENCRYPTION_KEY',
      'STASH_KV_TOKEN',
      'KV_REST_API_TOKEN',
      'UPSTASH_REDIS_REST_TOKEN',
    ]);
  });
});

describe('findLeakedValues', () => {
  it('finds a token inlined into a bundle', async () => {
    const files = await fixture({
      'app.js': 'const t="oauth-token-abcdefghijklmnop";export{t};',
      'style.css': 'body{color:red}',
    });

    const found = await findLeakedValues(
      files,
      new Map([['INSTAPAPER_OAUTH_TOKEN', 'oauth-token-abcdefghijklmnop']]),
    );

    expect(found).toHaveLength(1);
    expect(found[0]?.variable).toBe('INSTAPAPER_OAUTH_TOKEN');
  });

  it('reports every hit rather than stopping at the first', async () => {
    // A build that leaked one secret has very likely leaked its neighbours, and a
    // report you have to run four times to see the whole of is a report people stop
    // running.
    const files = await fixture({
      'a.js': 'const a="secret-one-abcdefghijkl";',
      'b.js': 'const b="secret-two-mnopqrstuvwx";',
    });

    const found = await findLeakedValues(
      files,
      new Map([
        ['STASH_PASSPHRASE', 'secret-one-abcdefghijkl'],
        ['STASH_ENCRYPTION_KEY', 'secret-two-mnopqrstuvwx'],
      ]),
    );

    expect(found.map((f) => f.variable).sort()).toEqual([
      'STASH_ENCRYPTION_KEY',
      'STASH_PASSPHRASE',
    ]);
  });

  it('is clean when nothing leaked', async () => {
    const files = await fixture({ 'app.js': 'console.log("hello");' });
    expect(
      await findLeakedValues(files, new Map([['STASH_PASSPHRASE', 'not-in-here-at-all']])),
    ).toEqual([]);
  });

  it('does not fall over on a file it cannot read', async () => {
    const files = await fixture({ 'app.js': 'x' });
    const found = await findLeakedValues(
      [...files, '/nonexistent/path/app.js'],
      new Map([['STASH_PASSPHRASE', 'anything-at-all-here']]),
    );
    expect(found).toEqual([]);
  });
});

describe('findViteReferences', () => {
  it('catches a secret exposed through a VITE_ variable', () => {
    /*
     * The mistake this exists for: anything named `VITE_*` is inlined into the client
     * bundle by design, and `import.meta.env` looks close enough to `process.env` that
     * reaching for the wrong one is natural. The app works perfectly afterwards, which
     * is what makes it worth a check.
     */
    expect(findViteReferences('const t = import.meta.env.VITE_INSTAPAPER_OAUTH_TOKEN;')).toEqual([
      'VITE_INSTAPAPER_OAUTH_TOKEN',
    ]);

    expect(findViteReferences('import.meta.env.VITE_STASH_PASSPHRASE')).toEqual([
      'VITE_STASH_PASSPHRASE',
    ]);
  });

  it('ignores VITE_ variables that are not secrets', () => {
    // A build-time flag or a public base URL is exactly what the prefix is for.
    expect(findViteReferences('import.meta.env.VITE_APP_VERSION')).toEqual([]);
    expect(findViteReferences('import.meta.env.MODE')).toEqual([]);
  });

  it('reports each name once however often it appears', () => {
    const source =
      'a(import.meta.env.VITE_STASH_PASSPHRASE); b(import.meta.env.VITE_STASH_PASSPHRASE);';
    expect(findViteReferences(source)).toEqual(['VITE_STASH_PASSPHRASE']);
  });
});
