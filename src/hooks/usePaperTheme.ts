/**
 * Puts the chosen paper on the document, and tells the browser about it.
 *
 * Two effects rather than one, because they are two different promises. The
 * `data-paper` attribute is what `theme.css` keys its palettes off, and it goes on
 * `<html>` so every screen is printed on the same sheet — the front page, the
 * reading view, settings and the gate alike.
 *
 * The `theme-color` meta is the other half, and on Android it is the visible one:
 * Chrome tints its own toolbar with it, so without this the browser keeps a beige
 * bar above a white page. It is only the light-scheme meta that moves; the dark one
 * stays as it is, because the papers deliberately do not apply in dark mode.
 */
import { useEffect } from 'react';

import { PAPERS, DEFAULT_PREFS, type PaperId } from '../lib/prefs.js';
import { useReadingPrefs } from '../lib/queries.js';

export function usePaperTheme(): PaperId {
  const { data: prefs } = useReadingPrefs();
  const paper = prefs?.paper ?? DEFAULT_PREFS.paper;

  useEffect(() => {
    document.documentElement.dataset.paper = paper;
  }, [paper]);

  useEffect(() => {
    const meta = document.querySelector('meta[name="theme-color"][media*="light"]');
    meta?.setAttribute('content', PAPERS[paper].swatch);
  }, [paper]);

  return paper;
}
