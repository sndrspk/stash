/**
 * Pulls the latin-subset woff2 for the four reading faces into `public/fonts/`.
 *
 * The files are committed — a build must not depend on Google being reachable — so
 * this only needs re-running to pick up an upstream revision or to add a family.
 * Run with `npm run fonts`, then check the diff: a changed file is a new font
 * version, and worth a glance at the rendered result before committing.
 *
 * All four are OFL-licensed; see public/fonts/LICENSE.md.
 */
import { mkdir, writeFile } from 'node:fs/promises';

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

const FAMILIES = [
  {
    slug: 'source-serif-4',
    spec: 'Source+Serif+4:ital,opsz,wght@0,8..60,400..700;1,8..60,400..700',
  },
  { slug: 'crimson-pro', spec: 'Crimson+Pro:ital,wght@0,400..700;1,400..700' },
  { slug: 'piazzolla', spec: 'Piazzolla:ital,wght@0,400..700;1,400..700' },
  { slug: 'geist', spec: 'Geist:wght@400..700' },
];

// The latin subset is the block whose unicode-range opens at U+0000-00FF. The CSS
// also carries cyrillic, greek, vietnamese and latin-ext; we want none of them.
const isLatin = (block: string) => /unicode-range:\s*U\+0000-00FF/i.test(block);

await mkdir('public/fonts', { recursive: true });
const manifest: Array<{ file: string; style: string; kb: number }> = [];

for (const { slug, spec } of FAMILIES) {
  const css = await fetch(`https://fonts.googleapis.com/css2?family=${spec}&display=swap`, {
    headers: { 'User-Agent': UA },
  }).then((r) => r.text());

  const blocks = css.split('@font-face').filter(isLatin);
  for (const block of blocks) {
    const url = block.match(/src:\s*url\(([^)]+)\)/)?.[1];
    const style = block.match(/font-style:\s*(\w+)/)?.[1] ?? 'normal';
    if (!url) continue;

    const file = `${slug}${style === 'italic' ? '-italic' : ''}-latin.woff2`;
    const buffer = await fetch(url).then((r) => r.arrayBuffer());
    const bytes = new Uint8Array(buffer);
    await writeFile(`public/fonts/${file}`, bytes);
    manifest.push({ file, style, kb: Math.round(bytes.length / 1024) });
  }
}

console.table(manifest);
