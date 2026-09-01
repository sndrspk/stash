import { describe, expect, it } from 'vitest';

import { computeColumns, pageStride, snapTarget, strideFromBox } from '../src/lib/columns';

/** A plausible desktop reading view: 34em columns at 18px, in an 800px-tall window. */
const DESKTOP = {
  availableHeight: 800,
  columnWidth: 612,
  gap: 48,
  horizontalPadding: 96,
};

describe('computeColumns', () => {
  it('gives one column to an article that fits on one screen', () => {
    const { columnCount, width } = computeColumns({ ...DESKTOP, naturalHeight: 700 });

    expect(columnCount).toBe(1);
    // One column has no gap in it, so the box is the column plus its padding.
    expect(width).toBe(612 + 96);
  });

  it('rounds up: a remainder of one line still needs a column to put it in', () => {
    expect(computeColumns({ ...DESKTOP, naturalHeight: 801 }).columnCount).toBe(2);
    expect(computeColumns({ ...DESKTOP, naturalHeight: 1600 }).columnCount).toBe(2);
    expect(computeColumns({ ...DESKTOP, naturalHeight: 1601 }).columnCount).toBe(3);
  });

  it('counts n-1 gaps for n columns', () => {
    const { width } = computeColumns({ ...DESKTOP, naturalHeight: 2400 });

    expect(computeColumns({ ...DESKTOP, naturalHeight: 2400 }).columnCount).toBe(3);
    // Three columns, two gaps, one lot of padding — the gap after the last column
    // is exactly the bleed the explicit width exists to remove.
    expect(width).toBe(3 * 612 + 2 * 48 + 96);
  });

  it('is the spec’s formula, at every size', () => {
    // The formula rather than a table of cases, because the point is that the box's
    // edge lands where the content ends for *any* article, not for the ones I tried.
    for (const naturalHeight of [1, 799, 800, 4000, 40_000]) {
      for (const availableHeight of [320, 800, 1400]) {
        for (const columnWidth of [396, 612, 1008]) {
          const inputs = {
            naturalHeight,
            availableHeight,
            columnWidth,
            gap: 48,
            horizontalPadding: 96,
          };
          const { columnCount, width } = computeColumns(inputs);

          expect(columnCount).toBe(Math.max(1, Math.ceil(naturalHeight / availableHeight)));
          expect(width).toBe(columnCount * (columnWidth + 48) - 48 + 96);
        }
      }
    }
  });

  it('never asks for fewer than one column', () => {
    // An empty article still has a box, and ceil(0 / h) is 0 — which would make the
    // width negative once the trailing gap was subtracted.
    const { columnCount, width } = computeColumns({ ...DESKTOP, naturalHeight: 0 });

    expect(columnCount).toBe(1);
    expect(width).toBeGreaterThan(0);
  });

  it('survives a zero-height viewport rather than asking for Infinity columns', () => {
    // A hidden tab, or a measurement taken before layout.
    const { columnCount, width } = computeColumns({
      ...DESKTOP,
      naturalHeight: 4000,
      availableHeight: 0,
    });

    expect(Number.isFinite(columnCount)).toBe(true);
    expect(Number.isFinite(width)).toBe(true);
  });
});

describe('strideFromBox', () => {
  it('is one column plus one gap, from the laid-out box', () => {
    // Three 612px columns with 48px gaps and 96px of padding: the box is
    // 3*612 + 2*48 + 96 = 2028, and the stride is 660.
    expect(
      strideFromBox({ clientWidth: 2028, horizontalPadding: 96, columnCount: 3, gap: 48 }),
    ).toBe(660);
  });

  it('is the whole content box for a single column', () => {
    expect(
      strideFromBox({ clientWidth: 708, horizontalPadding: 96, columnCount: 1, gap: 48 }),
    ).toBe(660);
  });

  it('inverts what computeColumns produced, at every size', () => {
    // The two are a pair: the stride the snap uses must be exactly the one the
    // layout was built from, or every snap lands slightly off.
    for (const naturalHeight of [900, 4000, 40_000]) {
      for (const columnWidth of [396, 612, 1008]) {
        const gap = 48;
        const horizontalPadding = 96;
        const { columnCount, width } = computeColumns({
          naturalHeight,
          availableHeight: 800,
          columnWidth,
          gap,
          horizontalPadding,
        });

        const stride = strideFromBox({
          clientWidth: width,
          horizontalPadding,
          columnCount,
          gap,
        });
        expect(stride).toBeCloseTo(columnWidth + gap, 6);
      }
    }
  });

  it('is null when the box has not been laid out yet', () => {
    expect(
      strideFromBox({ clientWidth: 0, horizontalPadding: 96, columnCount: 3, gap: 48 }),
    ).toBeNull();
    expect(
      strideFromBox({ clientWidth: 96, horizontalPadding: 96, columnCount: 3, gap: 48 }),
    ).toBeNull();
  });

  it('is null for a nonsense column count', () => {
    for (const columnCount of [0, -1, NaN]) {
      expect(
        strideFromBox({ clientWidth: 2028, horizontalPadding: 96, columnCount, gap: 48 }),
        String(columnCount),
      ).toBeNull();
    }
  });
});

describe('snapTarget', () => {
  const STRIDE = 660;
  const MAX = 3300;

  it('rounds to the nearest boundary', () => {
    expect(snapTarget(700, STRIDE, MAX)).toBe(660);
    expect(snapTarget(1000, STRIDE, MAX)).toBe(1320);
    expect(snapTarget(1320, STRIDE, MAX)).toBe(1320);
  });

  it('returns the first column to exactly zero', () => {
    // Not to "column 0's boundary": the article's opening keeps the intro padding
    // it was laid out with, and rounding would shave it off.
    expect(snapTarget(0, STRIDE, MAX)).toBe(0);
    expect(snapTarget(40, STRIDE, MAX)).toBe(0);
    expect(snapTarget(300, STRIDE, MAX)).toBe(0);
  });

  it('never scrolls past the end of the article', () => {
    expect(snapTarget(3290, STRIDE, MAX)).toBeLessThanOrEqual(MAX);
    expect(snapTarget(99_999, STRIDE, MAX)).toBe(MAX);
  });

  it('goes all the way to the end rather than landing just short of it', () => {
    // Landing short puts the viewport's right edge inside the final column and
    // cuts the article's closing lines mid-word — with the trailing whitespace
    // the explicit width exists to produce sitting just off screen.
    expect(snapTarget(MAX, STRIDE, MAX)).toBe(MAX);
    expect(snapTarget(MAX - 40, STRIDE, MAX)).toBe(MAX);
    expect(snapTarget(MAX - STRIDE / 2 + 1, STRIDE, MAX)).toBe(MAX);
  });

  it('still rounds normally away from the ends', () => {
    expect(snapTarget(MAX - STRIDE, STRIDE, MAX)).toBeLessThan(MAX);
  });

  it('never scrolls before the start', () => {
    expect(snapTarget(-500, STRIDE, MAX)).toBe(0);
  });

  it('accounts for the leading padding when there is some', () => {
    // With 96px of padding the boundaries are at 96, 756, 1416 — not 0, 660, 1320.
    expect(snapTarget(760, STRIDE, MAX, 96)).toBe(756);
  });

  it('does nothing at all when the stride is unknown', () => {
    expect(snapTarget(1234, 0, MAX)).toBe(1234);
    expect(snapTarget(1234, -1, MAX)).toBe(1234);
  });
});

describe('pageStride', () => {
  it('turns by whole columns, as many as are visible', () => {
    // Three columns visible: a page turn moves three, not one — moving a third of
    // a screen reads as a jitter rather than as a page.
    expect(pageStride(2000, 660)).toBe(1980);
    expect(pageStride(1400, 660)).toBe(1320);
  });

  it('turns by one column when only one fits', () => {
    expect(pageStride(700, 660)).toBe(660);
  });

  it('still turns when the column is wider than the window', () => {
    // A narrow phone with a Wide column preset: never zero, or the page would not
    // turn at all.
    expect(pageStride(390, 660)).toBe(660);
  });

  it('falls back to the viewport when the stride is unknown', () => {
    expect(pageStride(800, 0)).toBe(800);
  });
});
