/**
 * Reading preferences: what they are, and what to do with a stored value that is no
 * longer one of them.
 *
 * Four settings, from spec §4: face, size, line height, and column width. They are
 * sticky across articles and sessions, they apply live, and they are the basis for
 * the multi-column layout rather than decoration on top of it — the column width in
 * particular is an input to the pagination arithmetic, so a nonsense value here
 * becomes a nonsense article there.
 *
 * Which is why everything below is normalised on the way out of storage rather than
 * trusted. These rows survive across versions of the app on a device we do not
 * control; a preset renamed in a later release must degrade to the default, not
 * leave the reader with an unreadable column and no way back.
 */

/** The curated list from the spec, all four self-hosted. */
export const FONTS = {
  'source-serif': { label: 'Source Serif', stack: "'Source Serif 4', Georgia, serif" },
  crimson: { label: 'Crimson Pro', stack: "'Crimson Pro', Georgia, serif" },
  piazzolla: { label: 'Piazzolla', stack: "'Piazzolla', Georgia, serif" },
  geist: { label: 'Geist', stack: "'Geist', ui-sans-serif, system-ui, sans-serif" },
} as const;

export type FontId = keyof typeof FONTS;

/** The spec's three, verbatim: Narrow 22em, Medium 34em, Wide 56em. */
export const COLUMN_WIDTHS = {
  narrow: { label: 'Narrow', em: 22 },
  medium: { label: 'Medium', em: 34 },
  wide: { label: 'Wide', em: 56 },
} as const;

export type ColumnWidthId = keyof typeof COLUMN_WIDTHS;

/** Bounds, in the units the CSS uses. Generous, but not absurd in either direction. */
export const FONT_SIZE = { min: 0.875, max: 1.75, step: 0.0625, default: 1.125 };
export const LINE_HEIGHT = { min: 1.3, max: 2.0, step: 0.05, default: 1.6 };

export interface ReadingPrefs {
  font: FontId;
  /** rem */
  fontSize: number;
  lineHeight: number;
  columnWidth: ColumnWidthId;
}

export const DEFAULT_PREFS: ReadingPrefs = {
  font: 'source-serif',
  fontSize: FONT_SIZE.default,
  lineHeight: LINE_HEIGHT.default,
  columnWidth: 'medium',
};

const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));

/**
 * Rounded to the slider's step, so the stored value and the control agree.
 *
 * The trailing round to four places is not decoration: `Math.round(1.7 / 0.05) * 0.05`
 * is `1.7000000000000002` in binary floating point, and that value goes to storage,
 * comes back, and is snapped again on every read — so without it a preference the
 * reader never touches drifts a little further from itself each time the app opens.
 */
const snap = (value: number, step: number): number =>
  Math.round((Math.round(value / step) * step + Number.EPSILON) * 10_000) / 10_000;

/**
 * Whatever came out of storage, turned into something the reading view can use.
 *
 * Field by field rather than all-or-nothing: a reader who has set a size and a face
 * and then meets a release that renames a column preset should keep their size and
 * their face.
 */
export function normalizePrefs(stored: unknown): ReadingPrefs {
  if (typeof stored !== 'object' || stored === null) return { ...DEFAULT_PREFS };
  const raw = stored as Partial<Record<keyof ReadingPrefs, unknown>>;

  const font =
    typeof raw.font === 'string' && raw.font in FONTS ? (raw.font as FontId) : DEFAULT_PREFS.font;

  const columnWidth =
    typeof raw.columnWidth === 'string' && raw.columnWidth in COLUMN_WIDTHS
      ? (raw.columnWidth as ColumnWidthId)
      : DEFAULT_PREFS.columnWidth;

  const fontSize =
    typeof raw.fontSize === 'number' && Number.isFinite(raw.fontSize)
      ? snap(clamp(raw.fontSize, FONT_SIZE.min, FONT_SIZE.max), FONT_SIZE.step)
      : DEFAULT_PREFS.fontSize;

  const lineHeight =
    typeof raw.lineHeight === 'number' && Number.isFinite(raw.lineHeight)
      ? snap(clamp(raw.lineHeight, LINE_HEIGHT.min, LINE_HEIGHT.max), LINE_HEIGHT.step)
      : DEFAULT_PREFS.lineHeight;

  return { font, fontSize, lineHeight, columnWidth };
}

/**
 * The preferences as CSS custom properties.
 *
 * One place that knows the mapping, because the pagination hook and the stylesheet
 * both depend on `--reading-column-width` meaning exactly the same thing.
 */
export function prefsToCss(prefs: ReadingPrefs): Record<string, string> {
  return {
    '--reading-font': FONTS[prefs.font].stack,
    '--reading-font-size': `${prefs.fontSize}rem`,
    '--reading-line-height': String(prefs.lineHeight),
    '--reading-column-width': `${COLUMN_WIDTHS[prefs.columnWidth].em}em`,
  };
}
