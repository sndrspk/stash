/**
 * The reading view's own settings, in the view rather than in Settings.
 *
 * Spec §5 puts them here deliberately: these four change what is on the screen in
 * front of you, and a preference you cannot see the effect of is one you set by
 * guesswork. The app-wide Settings screen keeps the account and the theme.
 */
import {
  COLUMN_WIDTHS,
  FONTS,
  FONT_SIZE,
  LINE_HEIGHT,
  type ColumnWidthId,
  type FontId,
  type ReadingPrefs,
  type ResolvedReadingMode,
} from '../lib/prefs';
import styles from './TypographyPanel.module.css';

export interface TypographyPanelProps {
  prefs: ReadingPrefs;
  /** What `auto` currently resolves to, so the panel shows what is in force. */
  mode: ResolvedReadingMode;
  onChange: (prefs: ReadingPrefs) => void;
  onClose: () => void;
}

const MODES: { id: ResolvedReadingMode; label: string }[] = [
  { id: 'paged', label: 'Paged' },
  { id: 'scrolling', label: 'Scrolling' },
];

export function TypographyPanel({ prefs, mode, onChange, onClose }: TypographyPanelProps) {
  const set = <K extends keyof ReadingPrefs>(key: K, value: ReadingPrefs[K]) =>
    onChange({ ...prefs, [key]: value });

  return (
    <div
      className={styles.panel}
      role="dialog"
      aria-label="Reading settings"
      // Escape closes the panel without leaving the article; the reading view's own
      // Escape handler would otherwise close the article underneath it.
      onKeyDown={(event) => {
        if (event.key === 'Escape') {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      {/*
        Layout first, because it changes more than the others do: the column-width
        control below means something different in each mode — a column in one, a
        maximum line length in the other.
      */}
      <fieldset className={styles.group}>
        <legend className={styles.legend}>Layout</legend>
        <div className={styles.choices}>
          {MODES.map(({ id, label }) => (
            <button
              key={id}
              type="button"
              className={id === mode ? styles.choiceOn : styles.choice}
              aria-pressed={id === mode}
              onClick={() => set('mode', id)}
            >
              {label}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className={styles.group}>
        <legend className={styles.legend}>Typeface</legend>
        <div className={styles.choices}>
          {(Object.keys(FONTS) as FontId[]).map((id) => (
            <button
              key={id}
              type="button"
              className={id === prefs.font ? styles.choiceOn : styles.choice}
              style={{ fontFamily: FONTS[id].stack }}
              aria-pressed={id === prefs.font}
              onClick={() => set('font', id)}
            >
              {FONTS[id].label}
            </button>
          ))}
        </div>
      </fieldset>

      <fieldset className={styles.group}>
        <legend className={styles.legend}>
          {mode === 'paged' ? 'Column width' : 'Text width'}
        </legend>
        <div className={styles.choices}>
          {(Object.keys(COLUMN_WIDTHS) as ColumnWidthId[]).map((id) => (
            <button
              key={id}
              type="button"
              className={id === prefs.columnWidth ? styles.choiceOn : styles.choice}
              aria-pressed={id === prefs.columnWidth}
              onClick={() => set('columnWidth', id)}
            >
              {COLUMN_WIDTHS[id].label}
            </button>
          ))}
        </div>
      </fieldset>

      <label className={styles.slider}>
        <span className={styles.legend}>Size</span>
        <input
          type="range"
          min={FONT_SIZE.min}
          max={FONT_SIZE.max}
          step={FONT_SIZE.step}
          value={prefs.fontSize}
          onChange={(event) => set('fontSize', Number(event.target.value))}
        />
        <span className={styles.value}>{Math.round(prefs.fontSize * 16)}px</span>
      </label>

      <label className={styles.slider}>
        <span className={styles.legend}>Line height</span>
        <input
          type="range"
          min={LINE_HEIGHT.min}
          max={LINE_HEIGHT.max}
          step={LINE_HEIGHT.step}
          value={prefs.lineHeight}
          onChange={(event) => set('lineHeight', Number(event.target.value))}
        />
        <span className={styles.value}>{prefs.lineHeight.toFixed(2)}</span>
      </label>
    </div>
  );
}
