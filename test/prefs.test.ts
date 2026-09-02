import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  COLUMN_WIDTHS,
  DEFAULT_PREFS,
  FONTS,
  FONT_SIZE,
  LINE_HEIGHT,
  PAGED_MIN_WIDTH_PX,
  PAPERS,
  normalizePrefs,
  prefsToCss,
  resolveReadingMode,
} from '../src/lib/prefs';

const PHONE = { coarsePointer: true, viewportWidth: 390 };
const PHONE_LANDSCAPE = { coarsePointer: true, viewportWidth: 844 };
const LAPTOP = { coarsePointer: false, viewportWidth: 1440 };
const NARROW_WINDOW = { coarsePointer: false, viewportWidth: 600 };
const TOUCH_LAPTOP = { coarsePointer: true, viewportWidth: 1440 };

describe('the presets', () => {
  it('is the spec’s column widths, verbatim', () => {
    expect(COLUMN_WIDTHS.narrow.em).toBe(22);
    expect(COLUMN_WIDTHS.medium.em).toBe(34);
    expect(COLUMN_WIDTHS.wide.em).toBe(56);
    expect(DEFAULT_PREFS.columnWidth).toBe('medium');
  });

  it('offers the spec’s four faces', () => {
    expect(Object.keys(FONTS).sort()).toEqual(['crimson', 'geist', 'piazzolla', 'source-serif']);
  });
});

describe('the papers', () => {
  const theme = readFileSync('src/styles/theme.css', 'utf8');

  it('offers beige plus the four alternatives', () => {
    expect(Object.keys(PAPERS).sort()).toEqual(['beige', 'blue', 'lilac', 'mustard', 'white']);
    expect(DEFAULT_PREFS.paper).toBe('beige');
  });

  /*
   * The swatch in the panel and the palette in the stylesheet are two halves of one
   * decision, and nothing but this test stops them drifting: a swatch that no longer
   * matches the paper it selects is a control that lies, and it would look perfectly
   * fine in a screenshot of either half on its own.
   */
  it('paints each swatch the colour the stylesheet gives that paper', () => {
    for (const [id, { swatch }] of Object.entries(PAPERS)) {
      if (id === DEFAULT_PREFS.paper) continue; // the default lives on bare :root

      const block = new RegExp(`:root\\[data-paper='${id}'\\]\\s*\\{([^}]*)\\}`).exec(theme);
      expect(block, `no theme.css block for '${id}'`).not.toBeNull();

      const paper = /--paper:\s*(#[0-9a-f]{6})/i.exec(block![1] ?? '')?.[1];
      expect(paper?.toLowerCase(), `--paper for '${id}'`).toBe(swatch.toLowerCase());
    }
  });

  it('paints the default swatch the colour of the bare :root paper', () => {
    const base = /:root\s*\{([\s\S]*?)\}/.exec(theme)?.[1] ?? '';
    const paper = /--paper:\s*(#[0-9a-f]{6})/i.exec(base)?.[1];
    expect(paper?.toLowerCase()).toBe(PAPERS[DEFAULT_PREFS.paper].swatch.toLowerCase());
  });

  /*
   * Order is the only thing separating these, because the selectors have equal
   * specificity — and it has to go this way round. A pale blue sheet under a dark
   * theme's light ink would be unreadable, and a reader who asked for dark asked for
   * dark.
   */
  it('declares the papers above the dark palettes, so dark wins', () => {
    const lastPaper = Math.max(
      ...Object.keys(PAPERS)
        .filter((id) => id !== DEFAULT_PREFS.paper)
        .map((id) => theme.indexOf(`:root[data-paper='${id}']`)),
    );
    expect(lastPaper).toBeGreaterThan(0);
    expect(theme.indexOf('prefers-color-scheme: dark')).toBeGreaterThan(lastPaper);
    expect(theme.indexOf(":root[data-theme='dark']")).toBeGreaterThan(lastPaper);
  });
});

describe('resolveReadingMode', () => {
  it('defaults a phone to scrolling', () => {
    expect(resolveReadingMode('auto', PHONE)).toBe('scrolling');
  });

  it('defaults a desktop to paged', () => {
    expect(resolveReadingMode('auto', LAPTOP)).toBe('paged');
  });

  it('leaves a narrow desktop window paged', () => {
    // Narrowing a window is not the same as reading on a phone: the column clamp
    // already makes that case work, and changing how the app behaves when someone
    // drags a window edge would be its own kind of wrong.
    expect(resolveReadingMode('auto', NARROW_WINDOW)).toBe('paged');
  });

  it('leaves a touchscreen laptop paged', () => {
    expect(resolveReadingMode('auto', TOUCH_LAPTOP)).toBe('paged');
  });

  it('treats a phone turned sideways as a tablet, by width', () => {
    // A judgement, not a measurement — and one an explicit choice overrides.
    expect(resolveReadingMode('auto', PHONE_LANDSCAPE)).toBe('paged');
    expect(PAGED_MIN_WIDTH_PX).toBeGreaterThan(390);
  });

  it('obeys an explicit choice on every device', () => {
    for (const device of [PHONE, PHONE_LANDSCAPE, LAPTOP, NARROW_WINDOW, TOUCH_LAPTOP]) {
      expect(resolveReadingMode('paged', device)).toBe('paged');
      expect(resolveReadingMode('scrolling', device)).toBe('scrolling');
    }
  });
});

describe('normalizePrefs', () => {
  it('accepts a valid stored object unchanged', () => {
    const stored = {
      font: 'crimson',
      fontSize: 1.25,
      lineHeight: 1.7,
      columnWidth: 'wide',
      mode: 'scrolling',
      paper: 'blue',
    };
    expect(normalizePrefs(stored)).toEqual(stored);
  });

  it('defaults the mode to auto, so the device decides', () => {
    expect(normalizePrefs({}).mode).toBe('auto');
    expect(normalizePrefs({ mode: 'sideways' }).mode).toBe('auto');
    expect(normalizePrefs({ mode: 42 }).mode).toBe('auto');
  });

  it('falls back to beige for a paper that no longer exists', () => {
    expect(normalizePrefs({ paper: 'chartreuse' }).paper).toBe('beige');
    expect(normalizePrefs({ paper: 7 }).paper).toBe('beige');
    expect(normalizePrefs({}).paper).toBe('beige');
  });

  it('keeps a valid paper', () => {
    for (const id of Object.keys(PAPERS)) {
      expect(normalizePrefs({ paper: id }).paper).toBe(id);
    }
  });

  it('keeps an explicit mode', () => {
    expect(normalizePrefs({ mode: 'paged' }).mode).toBe('paged');
    expect(normalizePrefs({ mode: 'scrolling' }).mode).toBe('scrolling');
  });

  it('returns the defaults for nothing at all', () => {
    for (const nothing of [undefined, null, 'a string', 42, []]) {
      expect(normalizePrefs(nothing)).toEqual(DEFAULT_PREFS);
    }
  });

  it('repairs field by field, keeping what is still valid', () => {
    // A reader who set a size and a face, meeting a release that renamed a column
    // preset, keeps their size and their face.
    const result = normalizePrefs({
      font: 'crimson',
      fontSize: 1.25,
      lineHeight: 1.7,
      columnWidth: 'extra-wide-2024',
    });

    expect(result.font).toBe('crimson');
    expect(result.fontSize).toBe(1.25);
    expect(result.columnWidth).toBe(DEFAULT_PREFS.columnWidth);
  });

  it('falls back for a face that no longer exists', () => {
    expect(normalizePrefs({ font: 'comic-sans' }).font).toBe(DEFAULT_PREFS.font);
  });

  it('clamps a size or line height that is out of range', () => {
    // A stored value from a future release with wider bounds must not produce an
    // unreadable column with no way back.
    expect(normalizePrefs({ fontSize: 99 }).fontSize).toBe(FONT_SIZE.max);
    expect(normalizePrefs({ fontSize: 0.1 }).fontSize).toBe(FONT_SIZE.min);
    expect(normalizePrefs({ lineHeight: 12 }).lineHeight).toBe(LINE_HEIGHT.max);
    expect(normalizePrefs({ lineHeight: 0 }).lineHeight).toBe(LINE_HEIGHT.min);
  });

  it('lets line height go tight enough for a small-x-height face', () => {
    /*
     * Pinned to a number rather than to the constant, because the point is the number.
     * The right leading is a property of the typeface: at a given multiplier Crimson
     * Pro sets looser than Geist, and a floor of 1.3 left the tightest available
     * setting still airier than some of these faces want. 1.15 is where ascenders and
     * descenders on consecutive lines stop having room to collide — a floor, not a
     * preference, which is why a change to it should have to change this line too.
     */
    expect(LINE_HEIGHT.min).toBe(1.15);
    expect(normalizePrefs({ lineHeight: 1.15 }).lineHeight).toBe(1.15);
    // And every tick between the floor and the old one is reachable.
    for (const tick of [1.2, 1.25, 1.3]) {
      expect(normalizePrefs({ lineHeight: tick }).lineHeight, String(tick)).toBe(tick);
    }
  });

  it('rejects a size that is not a number', () => {
    for (const bad of [NaN, Infinity, -Infinity, '1.25', null]) {
      expect(normalizePrefs({ fontSize: bad }).fontSize, String(bad)).toBe(DEFAULT_PREFS.fontSize);
    }
  });

  it('snaps to the step, so the stored value and the slider agree', () => {
    const size = normalizePrefs({ fontSize: 1.13 }).fontSize;
    expect(Math.round(size / FONT_SIZE.step) * FONT_SIZE.step).toBeCloseTo(size, 6);
  });
});

describe('prefsToCss', () => {
  it('names the property the pagination and the stylesheet both read', () => {
    // `--reading-column-width` is an input to the column arithmetic *and* the clamp
    // that keeps wide embeds inside a column. One name, one meaning.
    const css = prefsToCss({ ...DEFAULT_PREFS, columnWidth: 'narrow' });
    expect(css['--reading-column-width']).toBe('22em');
  });

  it('resolves a face to a stack with a real fallback', () => {
    const css = prefsToCss({ ...DEFAULT_PREFS, font: 'piazzolla' });
    expect(css['--reading-font']).toContain('Piazzolla');
    // The webfont can fail; the article still has to be readable.
    expect(css['--reading-font']).toContain('serif');
  });

  it('emits units the browser will accept', () => {
    const css = prefsToCss(DEFAULT_PREFS);
    expect(css['--reading-font-size']).toMatch(/^[\d.]+rem$/);
    expect(css['--reading-line-height']).toMatch(/^[\d.]+$/);
  });
});
