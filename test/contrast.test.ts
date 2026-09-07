import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/*
 * Every ink is legible on every paper, in both themes.
 *
 * This exists because a Lighthouse pass found `--ink-faint` at 3.52:1 on the default
 * beige and stopped there — an audit runs against the page as loaded, and the page as
 * loaded has one of five papers and one of two themes. The real worst case was 2.99:1
 * on sunken lilac, and dark mode failed on all three of its surfaces without ever
 * being measured.
 *
 * That is the shape of the problem worth guarding: the papers move `--paper` while the
 * ink stays put, so a value chosen against the default can fail on a sheet nobody
 * checked, and no amount of auditing the default catches it. Ten surfaces times three
 * inks is thirty combinations, which is a test rather than a habit.
 *
 * WCAG AA, 4.5:1: `--ink-faint` carries the dateline, byline, crumb and provenance
 * line, all at 12px, which is under every large-text exemption there is.
 */
const THEME = readFileSync(new URL('../src/styles/theme.css', import.meta.url), 'utf8');

export const AA_NORMAL = 4.5;

const DECLARATION = /(--[\w-]+)\s*:\s*(#[0-9a-f]{6})\s*;/gi;

/**
 * Every `--name: #hex;` in one selector block, by block, at any nesting depth.
 *
 * A brace scan rather than a regex, because the dark palette lives inside an
 * `@media` wrapper. The obvious `([^{}]+)\{([^}]*)\}` reads that block's selector as
 * `@media (prefers-color-scheme: dark)` and its body as everything up to the *first*
 * closing brace — which happens to contain the right declarations under the wrong
 * name, so it looks like it works until you ask it for a selector it never emits.
 *
 * Declarations are attributed to their own block only: a wrapper gets the ones
 * written directly in it, which for `@media` is none.
 */
function blocks(source: string): { selector: string; tokens: Map<string, string> }[] {
  const found: { selector: string; tokens: Map<string, string> }[] = [];
  const open: { selector: string; tokens: Map<string, string> }[] = [];

  // Text seen since the last brace: the declarations of whichever block is open,
  // and — at its tail — the selector of the block about to open.
  let buffer = '';

  const drain = (into: Map<string, string> | undefined) => {
    for (const decl of buffer.matchAll(DECLARATION)) {
      into?.set(decl[1] ?? '', (decl[2] ?? '').toLowerCase());
    }
  };

  for (const char of source) {
    if (char === '{') {
      // Anything declared before a nested block still belongs to the parent.
      drain(open[open.length - 1]?.tokens);
      open.push({
        selector: buffer.trim().split('\n').pop()?.trim() ?? '',
        tokens: new Map<string, string>(),
      });
      buffer = '';
    } else if (char === '}') {
      const frame = open.pop();
      if (frame !== undefined) {
        drain(frame.tokens);
        if (frame.tokens.size > 0) found.push(frame);
      }
      buffer = '';
    } else {
      buffer += char;
    }
  }
  return found;
}

function channel(value: number): number {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance. */
export function luminance(hex: string): number {
  const h = hex.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => Number.parseInt(h.slice(i, i + 2), 16));
  return 0.2126 * channel(r ?? 0) + 0.7152 * channel(g ?? 0) + 0.0722 * channel(b ?? 0);
}

export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05);
}

const all = blocks(THEME);
const at = (selector: string) => all.find((block) => block.selector === selector)?.tokens;

const root = at(':root');
const dark = at(":root[data-theme='dark']");
const papers = ['white', 'blue', 'lilac', 'mustard'].map((name) => ({
  name,
  tokens: at(`:root[data-paper='${name}']`),
}));

const INKS = ['--ink', '--ink-muted', '--ink-faint'] as const;
const SURFACES = ['--paper', '--paper-raised', '--paper-sunken'] as const;

describe('theme contrast', () => {
  it('found the palette it means to check', () => {
    // A selector rename would otherwise leave this suite asserting nothing at all,
    // which is the failure mode every scan in this repo guards against.
    expect(root, ':root').toBeDefined();
    expect(dark, ":root[data-theme='dark']").toBeDefined();
    for (const paper of papers) expect(paper.tokens, paper.name).toBeDefined();
    for (const token of [...INKS, ...SURFACES]) expect(root?.get(token), token).toMatch(/^#/);
  });

  /** A paper block overrides only its surfaces; the inks come from `:root`. */
  const lightSheets = [
    { name: 'beige (default)', tokens: root },
    ...papers.map((paper) => ({
      name: paper.name,
      tokens: new Map([...(root ?? []), ...(paper.tokens ?? [])]),
    })),
  ];

  for (const sheet of lightSheets) {
    for (const ink of INKS) {
      for (const surface of SURFACES) {
        it(`light: ${ink} on ${surface} of ${sheet.name}`, () => {
          const fg = sheet.tokens?.get(ink);
          const bg = sheet.tokens?.get(surface);
          expect(fg, ink).toBeDefined();
          expect(bg, surface).toBeDefined();
          expect(
            contrast(fg ?? '#000000', bg ?? '#ffffff'),
            `${ink} ${String(fg)} on ${surface} ${String(bg)} of ${sheet.name}`,
          ).toBeGreaterThanOrEqual(AA_NORMAL);
        });
      }
    }
  }

  for (const ink of INKS) {
    for (const surface of SURFACES) {
      it(`dark: ${ink} on ${surface}`, () => {
        const fg = dark?.get(ink);
        const bg = dark?.get(surface);
        expect(
          contrast(fg ?? '#000000', bg ?? '#ffffff'),
          `${ink} ${String(fg)} on ${surface} ${String(bg)}`,
        ).toBeGreaterThanOrEqual(AA_NORMAL);
      });
    }
  }

  it('keeps the two dark blocks identical', () => {
    // `prefers-color-scheme` and `data-theme='dark'` are the same palette written
    // twice, and a fix applied to one of them is a bug that only appears for readers
    // whose OS disagrees with their explicit choice.
    const media = all.find((block) => block.selector === ":root:not([data-theme='light'])");
    expect(media).toBeDefined();
    for (const [token, value] of dark ?? []) {
      expect(media?.tokens.get(token), `${token} differs between the two dark blocks`).toBe(value);
    }
  });

  it('keeps the ink hierarchy readable, not merely compliant', () => {
    // Passing AA by making everything the same colour would satisfy the assertions
    // above and destroy the design. Faint must stay fainter than muted, which must
    // stay fainter than ink — in whichever direction the theme runs.
    const order = (tokens: Map<string, string> | undefined) =>
      INKS.map((ink) => luminance(tokens?.get(ink) ?? '#000000'));
    const [ink, muted, faint] = order(root);
    expect(ink).toBeLessThan(muted ?? 0);
    expect(muted).toBeLessThan(faint ?? 0);

    const [dInk, dMuted, dFaint] = order(dark);
    expect(dInk).toBeGreaterThan(dMuted ?? 0);
    expect(dMuted).toBeGreaterThan(dFaint ?? 0);
  });
});
