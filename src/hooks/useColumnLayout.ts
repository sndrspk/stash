/**
 * The DOM half of the pagination: measure, compute, apply, and do it again whenever
 * anything that could change the answer changes.
 *
 * The measurement is the delicate part, and it is delicate in a specific way the
 * spec calls out: it must be taken from the **real content**, not a synthetic clone.
 * Images count towards the natural height, and a clone's images are not the same
 * images — they load separately, at different times, possibly not at all. So the
 * article is briefly reflowed to a single column in place, measured, and put back.
 *
 * Everything here is layout work done outside React's render: the hook writes
 * inline styles onto a DOM node rather than driving state, because a re-render per
 * measurement would fight the very reflow being measured.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { computeColumns, fitColumnWidth } from '../lib/columns.js';

/** Long enough for a chrome collapse to settle, short enough not to be felt. */
const RESIZE_DEBOUNCE_MS = 120;

/**
 * How many times the column count may be raised to absorb unbreakable content.
 *
 * Each pass costs one forced layout, and each one shrinks the overflow it is
 * correcting, so convergence is quick — the image-heavy fixture takes two. The
 * bound exists because a loop that failed to converge here would be a frozen tab
 * rather than a slightly wrong layout, which is a far worse failure.
 */
const MAX_CORRECTIONS = 6;

export interface ColumnLayoutState {
  columnCount: number;
  width: number;
  /** The gutter, in px, as actually rendered. The snap logic needs it. */
  gap: number;
  /** Bumped on each successful measure, for anything that wants to react to one. */
  generation: number;
}

export interface UseColumnLayout {
  state: ColumnLayoutState;
  /** Force a re-measure — after preferences change, or new content arrives. */
  remeasure: () => void;
}

/**
 * @param scroller the element that scrolls horizontally; its height is the space a
 *   column has to fill.
 * @param article the multi-column box itself.
 * @param deps anything whose change invalidates the current measurement.
 */
export function useColumnLayout(
  scroller: React.RefObject<HTMLElement | null>,
  article: React.RefObject<HTMLElement | null>,
  enabled: boolean,
): UseColumnLayout {
  const [state, setState] = useState<ColumnLayoutState>({
    columnCount: 1,
    width: 0,
    gap: 0,
    generation: 0,
  });

  // Guards a re-entrant measure: the reflow to one column can itself raise the
  // event that triggered us, and two measurements interleaved leave the article
  // stuck at columnCount 1.
  const measuring = useRef(false);
  /** The last layout actually published, so an unchanged one can be dropped. */
  const applied = useRef<{ columnCount: number; width: number; gap: number } | null>(null);

  const measure = useCallback(() => {
    const box = article.current;
    const view = scroller.current;
    if (box === null || view === null || measuring.current) return;

    measuring.current = true;
    try {
      /*
       * Clear our own inline values *before* reading anything back.
       *
       * This hook writes `column-width`, `column-count` and `width` as inline
       * styles, and inline styles win over the stylesheet — so a second measurement
       * that read `getComputedStyle(box).columnWidth` without clearing them would
       * read back its own previous answer rather than the reader's current
       * preference, and no preference change would ever take effect again.
       */
      box.style.columnWidth = '';
      box.style.columnCount = '';
      box.style.width = '';

      const styles = getComputedStyle(box);
      const paddingLeft = Number.parseFloat(styles.paddingLeft) || 0;
      const paddingRight = Number.parseFloat(styles.paddingRight) || 0;
      const paddingTop = Number.parseFloat(styles.paddingTop) || 0;
      const paddingBottom = Number.parseFloat(styles.paddingBottom) || 0;
      const gap = Number.parseFloat(styles.columnGap) || 0;

      // The preference, resolved from the custom property to px by the browser
      // rather than parsed out of an `em` string by us, then clamped to the screen.
      // See `fitColumnWidth` for why the clamp is not optional.
      const preferred = Number.parseFloat(styles.columnWidth) || box.clientWidth || 1;
      const columnWidth = fitColumnWidth(preferred, view.clientWidth - paddingLeft - paddingRight);

      /*
       * Where the reader is, as a fraction, so their place survives the reflow.
       *
       * Kept as a fraction of the scrollable extent rather than as a column index:
       * a preference change alters the column count, so index N is a different
       * place in the article afterwards, while "a third of the way through" is the
       * same place.
       */
      const previousExtent = view.scrollWidth - view.clientWidth;
      const scrollLeftBefore = view.scrollLeft;
      const progress = previousExtent > 0 ? scrollLeftBefore / previousExtent : 0;

      // Reflow to a single column, in place, with the real content and its real
      // images. Nothing paints between here and the restore below: no await, no
      // state update, one synchronous layout read.
      const savedStyles = box.style.cssText;
      box.style.columnCount = '1';
      box.style.columnWidth = 'auto';
      box.style.width = `${columnWidth + paddingLeft + paddingRight}px`;
      box.style.height = 'auto';

      const naturalHeight = box.scrollHeight - paddingTop - paddingBottom;

      box.style.cssText = savedStyles;

      /*
       * Undo what measuring did to the scroll position.
       *
       * As one column the article is a few hundred pixels wide instead of fifteen
       * thousand, so there is nothing left to scroll and **the browser clamps
       * `scrollLeft` to 0**. Restoring the styles brings the extent back but not the
       * position, which is now at the top of the article.
       *
       * That has to be put right here, before any decision about whether the layout
       * changed — a measurement that concludes "nothing to do" has still, by this
       * point, thrown the reader back to the first column. It is the one piece of
       * damage this function does unconditionally, so it is repaired
       * unconditionally.
       */
      if (view.scrollLeft !== scrollLeftBefore) view.scrollLeft = scrollLeftBefore;

      const availableHeight = view.clientHeight - paddingTop - paddingBottom;
      const horizontalPadding = paddingLeft + paddingRight;

      const apply = (count: number): number => {
        // The spec's width formula, evaluated for whatever count we have reached.
        const explicit = count * (columnWidth + gap) - gap + horizontalPadding;

        box.style.columnCount = String(count);
        box.style.columnWidth = `${columnWidth}px`;
        box.style.width = `${explicit}px`;
        box.style.height = `${availableHeight}px`;
        return explicit;
      };

      const computed = computeColumns({
        naturalHeight,
        availableHeight,
        columnWidth,
        gap,
        horizontalPadding,
      });

      /*
       * The formula is a lower bound, not an answer, and the gap is `break-inside`.
       *
       * The single-column measurement sees the article's text flowing continuously.
       * The columnar layout does not: a figure or a heading that must not be split
       * is pushed whole into the next column, leaving the bottom of the previous one
       * empty. On the image-heavy fixture that unused space came to nineteen extra
       * columns — the article bled a long way past a box sized for the height it
       * measured.
       *
       * So the computed count is applied and then *checked*, and raised by however
       * many columns the overflow implies, until nothing bleeds. It stays
       * deterministic — the same article at the same size always converges to the
       * same count — and it is bounded, because a runaway loop here would be a
       * frozen tab rather than a wrong layout.
       */
      let columnCount = computed.columnCount;
      let width = apply(columnCount);
      for (let attempt = 0; attempt < MAX_CORRECTIONS; attempt++) {
        const overflow = box.scrollWidth - box.clientWidth;
        if (overflow <= 1) break;
        columnCount += Math.max(1, Math.ceil(overflow / (columnWidth + gap)));
        width = apply(columnCount);
      }

      /*
       * A measurement that changed nothing publishes nothing.
       *
       * Every re-measure lands on the same answer unless the viewport, the
       * preferences or the content moved, and announcing an identical result would
       * re-render the screen and invalidate the snap's cached stride for nothing.
       * The reader's position is already correct by this point — it was put back
       * above — so there is nothing else to do.
       */
      const previous = applied.current;
      if (
        previous !== null &&
        previous.columnCount === columnCount &&
        previous.width === width &&
        previous.gap === gap
      ) {
        return;
      }
      applied.current = { columnCount, width, gap };

      /*
       * The layout moved, so the reader's place moves with it — by fraction rather
       * than by pixel or by column index, since a narrower column means a different
       * number of columns and "column 11" is no longer the same sentence, while "a
       * third of the way through" is.
       */
      const extent = view.scrollWidth - view.clientWidth;
      const restored = progress * extent;
      if (extent > 0 && Math.abs(restored - view.scrollLeft) > 1) view.scrollLeft = restored;

      setState((state) => ({
        columnCount,
        width,
        gap,
        generation: state.generation + 1,
      }));
    } finally {
      measuring.current = false;
    }
  }, [article, scroller]);

  /*
   * Re-measure when the viewport changes size.
   *
   * Watched through `visualViewport` and `window.resize` rather than with a
   * ResizeObserver on the scroller, and the difference is not stylistic. The
   * measurement reflows the article in place, which changes the scroller's content
   * box — so an observer on the scroller is woken by the very measurement it just
   * caused, and the article re-measures forever. That loop is invisible in a
   * screenshot: what it actually breaks is page turns, because each measurement
   * restores the scroll position and cancels the smooth scroll mid-flight.
   *
   * `visualViewport` is also the more precise instrument for the case this exists
   * for — iOS Safari's address bar collapsing, which changes the height a column
   * has to fill without changing any element's box.
   *
   * Debounced, because reflowing the article under the reader's finger mid-scroll
   * is the worst possible moment to be right.
   */
  useEffect(() => {
    if (!enabled) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(measure, RESIZE_DEBOUNCE_MS);
    };

    const viewport = window.visualViewport;
    viewport?.addEventListener('resize', schedule);
    window.addEventListener('resize', schedule);
    window.addEventListener('orientationchange', schedule);

    return () => {
      clearTimeout(timer);
      viewport?.removeEventListener('resize', schedule);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('orientationchange', schedule);
    };
  }, [enabled, measure]);

  /*
   * Re-measure on every image load — but only the first time each image loads.
   *
   * The reason for the rule is the spec's: an image with no declared dimensions
   * occupies nothing until it arrives, so the first measurement undercounts the
   * article's height and the reader gets too few columns, with the tail of the
   * article bleeding past the box's edge.
   *
   * The reason for the *qualification* is a feedback loop this had, and it is worth
   * recording because nothing about it is visible in a still screenshot. Measuring
   * clears the inline width so the box can be laid out as a single column. That
   * changes the article's width, which makes every `<picture>` and `srcset` image
   * re-evaluate which source it wants, which fires `load` again, which schedules
   * another measure. The article re-measured about fifteen times a second forever;
   * the visible symptom was not a flicker but that **page turns did not work** —
   * each measure restored the scroll position and cancelled the smooth scroll
   * mid-flight, so a turn moved two pixels and stopped.
   *
   * So: each element counts once, and events raised by our own measurement are
   * ignored while it runs. `load` does not bubble, hence the capture phase. Fonts
   * get one re-measure for the same reason images do — a face swapping in changes
   * every line height in the article.
   */
  useEffect(() => {
    if (!enabled) return;
    const box = article.current;
    if (box === null) return;

    let timer: ReturnType<typeof setTimeout> | undefined;
    const counted = new WeakSet<EventTarget>();

    const schedule = () => {
      clearTimeout(timer);
      // Coalesced: a gallery of sixty images would otherwise measure sixty times.
      timer = setTimeout(measure, 50);
    };

    const onLoad = (event: Event) => {
      if (measuring.current) return;
      const target = event.target;
      if (target === null || counted.has(target)) return;
      counted.add(target);
      schedule();
    };

    box.addEventListener('load', onLoad, true);
    box.addEventListener('error', onLoad, true);
    void document.fonts?.ready.then(schedule).catch(() => undefined);

    return () => {
      clearTimeout(timer);
      box.removeEventListener('load', onLoad, true);
      box.removeEventListener('error', onLoad, true);
    };
  }, [enabled, measure, article]);

  return { state, remeasure: measure };
}
