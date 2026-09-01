/**
 * What kind of thing the reader is holding.
 *
 * Only two facts are needed, and both are the browser's to answer rather than
 * ours: whether the pointer is a finger, and how wide the viewport is.
 * `resolveReadingMode` turns them into a default. Nothing here sniffs a user
 * agent — a string that lies about itself on half the devices that send it.
 *
 * Watched rather than read once, because both change: a phone rotates, a window is
 * dragged, and a laptop with a touchscreen can gain a coarse pointer mid-session.
 */
import { useEffect, useState } from 'react';

import type { DeviceShape } from '../lib/prefs.js';

const COARSE = '(pointer: coarse)';

function currentShape(): DeviceShape {
  return {
    coarsePointer: typeof matchMedia === 'function' ? matchMedia(COARSE).matches : false,
    viewportWidth: typeof window === 'undefined' ? 1024 : window.innerWidth,
  };
}

export function useReadingMode(): DeviceShape {
  const [shape, setShape] = useState<DeviceShape>(currentShape);

  useEffect(() => {
    const update = () => {
      setShape((previous) => {
        const next = currentShape();
        // Same object unless something actually changed: this feeds the reading
        // mode, which feeds whether the column layout runs at all, and a new object
        // every resize event would re-measure the article for nothing.
        return previous.coarsePointer === next.coarsePointer &&
          previous.viewportWidth === next.viewportWidth
          ? previous
          : next;
      });
    };

    const pointer = typeof matchMedia === 'function' ? matchMedia(COARSE) : null;
    pointer?.addEventListener('change', update);
    window.addEventListener('resize', update);
    window.addEventListener('orientationchange', update);

    return () => {
      pointer?.removeEventListener('change', update);
      window.removeEventListener('resize', update);
      window.removeEventListener('orientationchange', update);
    };
  }, []);

  return shape;
}
