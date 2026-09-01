/**
 * Landing on a column boundary, and the four ways to ask for the next page.
 *
 * The snap exists because of a specific complaint the spec records: a trackpad
 * scroll leaves the view stopped at an arbitrary pixel offset *between* columns, so
 * the reader is looking at half a column of one page and half of the next, with cut
 * words at both edges. Snapping after the scroll settles fixes it, and 140ms is the
 * settling window the native app arrived at — long enough that momentum has finished,
 * short enough that the correction feels like part of the gesture rather than a jump.
 *
 * The stride is read back from the **rendered box** — its `clientWidth`, its padding
 * and the `column-count` it is actually laying out with — never from the reader's
 * `column-width` preference. That distinction is the spec's, and it matters: a
 * balanced column can end up a different width from the one that was asked for, and
 * snapping to the requested value puts the view slightly off every time, which is
 * the original bug wearing a hat. See `strideFromBox` for why sampling text
 * positions, the obvious way to measure this, does not work.
 */
import { useCallback, useEffect, useRef } from 'react';

import { pageStride, snapTarget, strideFromBox } from '../lib/columns.js';

/** The settling window from the spec. */
export const SNAP_DEBOUNCE_MS = 140;

export interface UseColumnSnap {
  /** Move by one visible page. Negative for back. */
  turn: (direction: 1 | -1) => void;
  /** The rendered stride, or null before anything has been measured. */
  strideRef: React.RefObject<number | null>;
}

export function useColumnSnap(
  scroller: React.RefObject<HTMLElement | null>,
  article: React.RefObject<HTMLElement | null>,
  /** Bumped by the layout hook after every re-measure, to invalidate the stride. */
  generation: number,
  gap: number,
  enabled: boolean,
): UseColumnSnap {
  const strideRef = useRef<number | null>(null);
  // Set while a snap's own smooth scroll is in flight, so the scroll events it
  // generates do not schedule another snap on top of it.
  const snapping = useRef(false);

  const measureStride = useCallback((): number | null => {
    const box = article.current;
    if (box === null) return null;

    const styles = getComputedStyle(box);
    return strideFromBox({
      clientWidth: box.clientWidth,
      horizontalPadding:
        (Number.parseFloat(styles.paddingLeft) || 0) +
        (Number.parseFloat(styles.paddingRight) || 0),
      columnCount: Number.parseInt(styles.columnCount, 10),
      gap: Number.parseFloat(styles.columnGap) || gap,
    });
  }, [article, gap]);

  // The stride is only valid for the layout that produced it.
  useEffect(() => {
    strideRef.current = null;
  }, [generation]);

  const scrollTo = useCallback(
    (left: number) => {
      const view = scroller.current;
      if (view === null) return;
      snapping.current = true;
      view.scrollTo({ left, behavior: 'smooth' });
      // No scrollend event in every engine we care about, so this is a timer. It
      // only gates further snapping, so being generous costs nothing.
      setTimeout(() => {
        snapping.current = false;
      }, 400);
    },
    [scroller],
  );

  const turn = useCallback(
    (direction: 1 | -1) => {
      const view = scroller.current;
      if (view === null) return;

      strideRef.current ??= measureStride();
      const stride = strideRef.current;
      if (stride === null) {
        scrollTo(view.scrollLeft + direction * view.clientWidth);
        return;
      }

      const step = pageStride(view.clientWidth, stride);
      const max = view.scrollWidth - view.clientWidth;
      const padding = Number.parseFloat(getComputedStyle(view).paddingLeft) || 0;
      scrollTo(snapTarget(view.scrollLeft + direction * step, stride, max, padding));
    },
    [scroller, measureStride, scrollTo],
  );

  // Snap after the scroll settles.
  useEffect(() => {
    if (!enabled) return;
    const view = scroller.current;
    if (view === null) return;

    let timer: ReturnType<typeof setTimeout> | undefined;

    const onScroll = () => {
      if (snapping.current) return;
      clearTimeout(timer);
      timer = setTimeout(() => {
        strideRef.current ??= measureStride();
        const stride = strideRef.current;
        if (stride === null) return;

        const max = view.scrollWidth - view.clientWidth;
        const padding = Number.parseFloat(getComputedStyle(view).paddingLeft) || 0;
        const target = snapTarget(view.scrollLeft, stride, max, padding);
        // A sub-pixel correction is not worth a smooth scroll animation.
        if (Math.abs(target - view.scrollLeft) > 1) scrollTo(target);
      }, SNAP_DEBOUNCE_MS);
    };

    view.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      clearTimeout(timer);
      view.removeEventListener('scroll', onScroll);
    };
  }, [enabled, scroller, measureStride, scrollTo]);

  /*
   * A vertical wheel turns pages.
   *
   * On a mouse there is no horizontal axis to use, and on a trackpad a reader
   * scrolling "down" through an article means "onward" — which here is rightward.
   * A genuinely horizontal gesture is left to the browser, which already does the
   * right thing with it.
   */
  useEffect(() => {
    if (!enabled) return;
    const view = scroller.current;
    if (view === null) return;

    const onWheel = (event: WheelEvent) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      if (event.ctrlKey) return; // a pinch-zoom, not a scroll
      event.preventDefault();
      view.scrollLeft += event.deltaY;
    };

    view.addEventListener('wheel', onWheel, { passive: false });
    return () => view.removeEventListener('wheel', onWheel);
  }, [enabled, scroller]);

  return { turn, strideRef };
}
