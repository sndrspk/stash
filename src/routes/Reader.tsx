import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { TypographyPanel } from '../components/TypographyPanel';
import { useColumnLayout } from '../hooks/useColumnLayout';
import { useColumnSnap } from '../hooks/useColumnSnap';
import { removeFurniture } from '../lib/cleaners';
import type { BookmarkRecord } from '../lib/db';
import { needsExtraction } from '../lib/extraction';
import { prefsToCss, DEFAULT_PREFS, resolveReadingMode } from '../lib/prefs';
import { useReadingMode } from '../hooks/useReadingMode';
import {
  ApiError,
  useArticleSources,
  useArticleText,
  useBookmark,
  useBookmarkAction,
  useExtractArticle,
  useReadingPrefs,
  useSetReadingPrefs,
} from '../lib/queries';
import { sanitizeArticle } from '../lib/sanitize';
import styles from './Reader.module.css';

/**
 * The reading view: an article laid out in columns you move through sideways, not a
 * page you scroll down.
 *
 * The pagination lives in two hooks and one pure module, and the division is
 * deliberate — `lib/columns.ts` holds arithmetic that can be tested without a
 * browser, `useColumnLayout` holds the measurement that cannot, and this file holds
 * neither. What is here is the screen: the text, the controls, and the four ways to
 * turn a page.
 *
 * The one thing worth knowing before editing: the article's width is set explicitly
 * from a measurement, and must not be given a width by CSS. See `lib/columns.ts` for
 * what goes wrong when the browser is left to fit columns itself — it is not a
 * subtle bug, but it is an invisible one until an article is long enough.
 */
export function Reader() {
  const { bookmarkId } = useParams<{ bookmarkId: string }>();
  const navigate = useNavigate();
  const id = Number(bookmarkId);

  const { data: bookmark } = useBookmark(id);
  const { data: html, isLoading, isError } = useArticleText(id);
  const { data: sources } = useArticleSources(id);
  const extract = useExtractArticle();
  const [showOriginal, setShowOriginal] = useState(false);
  const [extractNote, setExtractNote] = useState<string | null>(null);
  const { data: stored } = useReadingPrefs();
  const setPrefs = useSetReadingPrefs();
  const prefs = stored ?? DEFAULT_PREFS;

  const archive = useBookmarkAction('archive');
  const remove = useBookmarkAction('delete');
  const [error, setError] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  const scroller = useRef<HTMLDivElement>(null);
  const article = useRef<HTMLElement>(null);
  const settings = useRef<HTMLDivElement>(null);

  // Paged or scrolling. `auto` — the default — is scrolling on a phone and paged
  // everywhere else; see `resolveReadingMode`.
  const device = useReadingMode();
  const mode = resolveReadingMode(prefs.mode, device);
  const paged = mode === 'paged';

  /*
   * Which copy is on screen, and the two passes it goes through.
   *
   * `removeFurniture` runs **here**, at render, not at extraction — that is the
   * whole reason it is a separate cleaner. A marker added next month cleans every
   * article already in the cache, with no re-sync and nothing invalidated.
   *
   * Sanitising is last and unconditional. It is the trust boundary, and both copies
   * are third-party HTML; running it once per article rather than once per render
   * is also the difference between a smooth reflow and a stutter.
   */
  const shown = showOriginal ? (sources?.instapaper ?? html) : html;
  const clean = useMemo(
    () => (shown === undefined ? '' : sanitizeArticle(removeFurniture(shown))),
    [shown],
  );
  const ready = clean !== '';

  /*
   * Whether to offer "fetch full content".
   *
   * Offered when Instapaper's own copy trips the truncation heuristic and there is
   * no extraction yet — the same question `extraction.ts` asks itself, deliberately
   * through the same function so the button and the gate cannot disagree.
   */
  const canExtract =
    bookmark !== undefined &&
    sources?.extracted == null &&
    needsExtraction(sources?.instapaper ?? undefined);

  /*
   * Whether the text already opens with its own headline.
   *
   * `get_text` normally returns the body alone, but not always — and a publisher
   * whose markup keeps the `<h1>` would otherwise get the title printed twice, once
   * by us and once by them. Compared on the first heading only, and loosely, since
   * the two spellings differ in punctuation more often than in words.
   */
  const titleIsInText = useMemo(() => {
    const title = bookmark?.title;
    if (title === undefined || title.trim() === '') return false;
    const heading = /<h[12][^>]*>([\s\S]*?)<\/h[12]>/i.exec(clean)?.[1];
    if (heading === undefined) return false;
    const normalise = (value: string) =>
      value
        .replace(/<[^>]+>/g, ' ')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()
        .toLowerCase();
    return normalise(heading) === normalise(title);
  }, [clean, bookmark?.title]);

  const { state, remeasure } = useColumnLayout(scroller, article, ready && paged);
  const { turn } = useColumnSnap(scroller, article, state.generation, state.gap, ready && paged);

  // Preferences apply live. The article is re-measured rather than merely restyled,
  // because every one of the four changes how much vertical space the text needs and
  // therefore how many columns it has to be cut into.
  // The headline is in the deps because it is part of the article: the bookmark row
  // resolves after the first render, and inserting a headline afterwards makes the
  // article taller — which is a re-measure, not a repaint.
  useEffect(() => {
    if (!ready || !paged) return;
    const frame = requestAnimationFrame(remeasure);
    return () => cancelAnimationFrame(frame);
  }, [prefs, ready, paged, remeasure, clean, bookmark?.title, titleIsInText]);

  /*
   * Extraction runs on its own when Instapaper's copy is a stub.
   *
   * Gated, not eager: `extractArticle` re-checks the heuristic, the week-long
   * backoff and the single-flight lock, so firing this on every open costs one
   * IndexedDB read for an article that has already been dealt with. `force` is
   * deliberately absent — this is the hint; the button is the decision.
   */
  const startExtract = extract.mutate;
  useEffect(() => {
    if (!canExtract || bookmark === undefined) return;
    startExtract({ bookmark });
  }, [canExtract, bookmark, startExtract]);

  const failed = archive.error ?? remove.error;
  useEffect(() => {
    if (failed instanceof ApiError && failed.status === 401) navigate('/unlock', { replace: true });
  }, [failed, navigate]);

  /*
   * A tap anywhere else closes the settings.
   *
   * The panel covers most of a phone screen, so requiring a second tap on the "Aa"
   * button to dismiss it means aiming at a 40px target that is behind the thing you
   * are trying to get rid of. `pointerdown` rather than `click` so it closes on the
   * way down, before the tap reaches whatever is underneath.
   */
  useEffect(() => {
    if (!showSettings) return;

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && settings.current?.contains(target) === true) return;
      setShowSettings(false);
    };

    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [showSettings]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      // Only Escape is bound in scrolling mode: arrows and space already scroll a
      // scrolling page, and taking them over to do the same thing worse would be
      // the kind of cleverness that breaks a screen reader's navigation.
      if (event.key === 'Escape') {
        navigate('/');
        return;
      }
      if (!paged) return;

      switch (event.key) {
        case 'ArrowRight':
        case 'PageDown':
          event.preventDefault();
          turn(1);
          break;
        case 'ArrowLeft':
        case 'PageUp':
          event.preventDefault();
          turn(-1);
          break;
        case ' ':
          event.preventDefault();
          turn(event.shiftKey ? -1 : 1);
          break;
        default:
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [turn, navigate, paged]);

  /*
   * The explicit "fetch full content" action.
   *
   * `force` is the whole of it: an explicit request is a decision, not a hint, so it
   * skips the truncation gate, the week-long backoff and the already-extracted check
   * alike. Everything it can report back is a fact about this article, which is why
   * a failure lands in a note beside the button rather than in the error banner.
   */
  function runExtract(force: boolean) {
    setExtractNote(null);
    extract
      .mutateAsync({ bookmark: bookmark as BookmarkRecord, force })
      .then((result) => {
        if (result.outcome?.kind === 'extracted') {
          setShowOriginal(false);
          setExtractNote(
            result.outcome.truncated
              ? 'Fetched, but it still looks like a stub — the publisher may want a signed-in session.'
              : null,
          );
          return;
        }
        if (result.outcome?.kind === 'blocked') {
          setExtractNote(`That page cannot be fetched: ${result.outcome.tag}.`);
          return;
        }
        if (result.outcome?.kind === 'failed') {
          setExtractNote(`The publisher's page could not be read: ${result.outcome.tag}.`);
          return;
        }
        setExtractNote('Nothing to fetch.');
      })
      .catch((cause: unknown) => {
        setExtractNote(
          `Could not fetch: ${cause instanceof Error ? cause.message : 'unknown error'}`,
        );
      });
  }

  function run(promise: Promise<unknown>, what: string) {
    setError(null);
    promise
      .then(() => navigate('/'))
      .catch((cause: unknown) => {
        setError(`Could not ${what}: ${cause instanceof Error ? cause.message : 'unknown error'}`);
      });
  }

  const busy = archive.isPending || remove.isPending;

  return (
    <div className={styles.screen} style={prefsToCss(prefs) as React.CSSProperties}>
      <header className={styles.bar}>
        <button type="button" className={styles.action} onClick={() => navigate('/')}>
          Close
        </button>

        <p className={styles.crumb}>{bookmark ? hostOf(bookmark.url) : ''}</p>

        {sources?.extracted != null && (
          <button
            type="button"
            className={styles.action}
            aria-pressed={showOriginal}
            onClick={() => setShowOriginal((original) => !original)}
            title={
              showOriginal
                ? 'Showing what Instapaper returned'
                : 'Showing the text Stash extracted from the publisher'
            }
          >
            {showOriginal ? 'Extracted' : 'Original'}
          </button>
        )}

        <div className={styles.actions}>
          <div className={styles.settingsWrap} ref={settings}>
            <button
              type="button"
              className={styles.action}
              aria-expanded={showSettings}
              onClick={() => setShowSettings((open) => !open)}
            >
              Aa
            </button>
            {showSettings && (
              <TypographyPanel
                prefs={prefs}
                mode={mode}
                onChange={(next) => setPrefs.mutate(next)}
                onClose={() => setShowSettings(false)}
              />
            )}
          </div>
          {canExtract && (
            <button
              type="button"
              className={styles.action}
              disabled={extract.isPending}
              onClick={() => runExtract(true)}
              title="Fetch the full article from the publisher"
            >
              {extract.isPending ? 'Fetching…' : 'Full text'}
            </button>
          )}
          <button
            type="button"
            className={styles.action}
            disabled={busy}
            onClick={() => run(archive.mutateAsync(id), 'archive')}
          >
            Archive
          </button>
          <button
            type="button"
            className={styles.danger}
            disabled={busy}
            onClick={() => {
              // Irreversible at Instapaper — there is no undo on their side.
              if (!confirm(`Delete "${bookmark?.title ?? bookmarkId}" permanently?`)) return;
              run(remove.mutateAsync(id), 'delete');
            }}
          >
            Delete
          </button>
        </div>
      </header>

      {error !== null && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      <div
        className={paged ? styles.viewport : styles.viewportScrolling}
        ref={scroller}
        data-column-count={paged ? state.columnCount : 1}
        data-reading-mode={mode}
      >
        {isLoading ? (
          <p className={styles.notice}>Fetching the article…</p>
        ) : isError ? (
          <p className={styles.notice} role="alert">
            The article could not be fetched. It may be worth trying again from the front page.
          </p>
        ) : !ready ? (
          <div className={styles.notice}>
            <p>Instapaper has no text for this one — a paywall, a video page, or a PDF.</p>
            {bookmark !== undefined && (
              <p>
                <button
                  type="button"
                  className={styles.action}
                  disabled={extract.isPending}
                  onClick={() => runExtract(true)}
                >
                  {extract.isPending ? 'Fetching…' : 'Fetch full content'}
                </button>
              </p>
            )}
            {extractNote !== null && <p className={styles.muted}>{extractNote}</p>}
          </div>
        ) : (
          <article
            className={paged ? styles.article : `${styles.article} ${styles.articleScrolling}`}
            ref={article}
          >
            {/*
              The headline, which `get_text` does not return — it gives the article
              body and nothing else. Without this the reading view opened straight
              into the first paragraph, or into the lead photograph, with the title
              nowhere on the screen.

              It lives inside the multi-column box rather than in the bar above it,
              so it flows as the first thing in the first column, the way a headline
              sits on a page. In the bar it would be a label; here it is the article
              beginning.
            */}
            {!titleIsInText && bookmark && (bookmark.title || '').trim() !== '' && (
              <header className={styles.headline}>
                <h1 className={styles.headlineText}>{bookmark.title}</h1>
                <p className={styles.byline}>{hostOf(bookmark.url)}</p>
              </header>
            )}
            <div
              // The trust boundary: `clean` is the only value ever injected, and
              // `sanitizeArticle` is the only thing that produces it.
              dangerouslySetInnerHTML={{ __html: clean }}
            />
          </article>
        )}
      </div>

      {ready && paged && (
        <>
          {/*
            Tap zones, as the spec's secondary affordance. A horizontal drag already
            works — the viewport scrolls natively, and the snap catches where it
            lands — so these are for the reader who taps rather than swipes. They sit
            under the article in z-order so a link is still a link.
          */}
          <button
            type="button"
            className={styles.tapBack}
            aria-label="Previous page"
            onClick={() => turn(-1)}
          />
          <button
            type="button"
            className={styles.tapForward}
            aria-label="Next page"
            onClick={() => turn(1)}
          />
        </>
      )}
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return '';
  }
}
