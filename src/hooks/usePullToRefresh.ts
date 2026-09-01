/**
 * Pull down at the top of the page to sync.
 *
 * An installed PWA has no browser chrome and therefore no reload button, so the
 * gesture people already have in every other reading app is the one refresh
 * affordance that needs no explaining. It never replaces the explicit button — a
 * pointer has no pull gesture, and neither does a keyboard.
 *
 * Three things make this behave rather than fight the browser:
 *
 * - It only engages when the page is **already scrolled to the top** when the finger
 *   lands. Deciding mid-gesture would steal a scroll that had begun as a scroll.
 * - It only engages once the drag is clearly **more vertical than horizontal**, so a
 *   sideways swipe is left alone.
 * - The distance is **damped**, so the indicator trails the finger. An indicator
 *   that tracks 1:1 feels like a bug when the page underneath is not moving.
 */
import { useEffect, useRef, useState } from 'react';

/** How far the finger must travel before a release counts as a refresh. */
export const PULL_THRESHOLD = 72;
/** Past this the indicator stops growing, however far the finger goes. */
export const PULL_MAX = 120;
/** Fraction of finger travel the indicator actually moves. */
const DAMPING = 0.5;

export interface PullToRefresh {
  /** 0 to PULL_MAX. Drive the indicator's offset from this. */
  distance: number;
  /** Whether releasing now would trigger a refresh. */
  armed: boolean;
}

export function usePullToRefresh(onRefresh: () => void, enabled = true): PullToRefresh {
  const [distance, setDistance] = useState(0);

  // Refs, not state: these change on every touchmove and must not re-render. They
  // are written only from event handlers, never during a render.
  const startY = useRef<number | null>(null);
  const startX = useRef(0);
  const engaged = useRef(false);
  const travelled = useRef(0);
  const refresh = useRef(onRefresh);

  useEffect(() => {
    refresh.current = onRefresh;
  }, [onRefresh]);

  useEffect(() => {
    if (!enabled) return;

    const atTop = () => window.scrollY <= 0;

    const clear = () => {
      startY.current = null;
      engaged.current = false;
      travelled.current = 0;
      setDistance(0);
    };

    const onStart = (event: TouchEvent) => {
      const touch = event.touches[0];
      if (touch === undefined || event.touches.length > 1 || !atTop()) {
        startY.current = null;
        return;
      }
      startY.current = touch.clientY;
      startX.current = touch.clientX;
      engaged.current = false;
    };

    const onMove = (event: TouchEvent) => {
      const from = startY.current;
      const touch = event.touches[0];
      if (from === null || touch === undefined) return;

      const dy = touch.clientY - from;
      const dx = Math.abs(touch.clientX - startX.current);

      if (dy <= 0 || !atTop()) {
        // Scrolled away, or pulling upward: this gesture is not ours after all.
        if (engaged.current) clear();
        return;
      }
      if (!engaged.current) {
        if (dy < 8) return; // too early to tell
        if (dx > dy) {
          startY.current = null; // a sideways swipe
          return;
        }
        engaged.current = true;
      }

      // Only now, and only because the gesture is ours: stop the page rubber-banding
      // underneath the indicator. The listener is non-passive purely for this.
      if (event.cancelable) event.preventDefault();
      travelled.current = Math.min(dy * DAMPING, PULL_MAX);
      setDistance(travelled.current);
    };

    const onEnd = () => {
      const pulled = engaged.current;
      const far = travelled.current >= PULL_THRESHOLD;
      clear();
      if (pulled && far) refresh.current();
    };

    window.addEventListener('touchstart', onStart, { passive: true });
    window.addEventListener('touchmove', onMove, { passive: false });
    window.addEventListener('touchend', onEnd, { passive: true });
    window.addEventListener('touchcancel', clear, { passive: true });

    return () => {
      window.removeEventListener('touchstart', onStart);
      window.removeEventListener('touchmove', onMove);
      window.removeEventListener('touchend', onEnd);
      window.removeEventListener('touchcancel', clear);
    };
  }, [enabled]);

  // Derived rather than cleared: a sync starting mid-pull disables the gesture, and
  // hiding the indicator by computing it avoids writing state from an effect to say
  // so. The listeners are unbound by the same flag, so nothing can grow it either.
  const shown = enabled ? distance : 0;
  return { distance: shown, armed: shown >= PULL_THRESHOLD };
}
