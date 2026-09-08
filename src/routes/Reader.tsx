import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { TypographyPanel } from '../components/TypographyPanel';
import { useColumnLayout } from '../hooks/useColumnLayout';
import { useColumnSnap } from '../hooks/useColumnSnap';
import { useOnline } from '../hooks/useOnline';
import { removeFurniture } from '../lib/furniture';
import type { FlushResult } from '../lib/pending';
import { prefsToCss, DEFAULT_PREFS, resolveReadingMode } from '../lib/prefs';
import { externalHref } from '../lib/sanitize';
import { useReadingMode } from '../hooks/useReadingMode';
import {
  ApiError,
  useArticleText,
  useBookmark,
  useBookmarkAction,
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
  const online = useOnline();
  const device = useReadingMode();
  const mode = resolveReadingMode(prefs.mode, device);
  const paged = mode === 'paged';

  /*
   * The one pass the article still goes through, and the trust boundary at the end.
   *
   * `removeFurniture` runs **here**, at render — that is the whole reason it is a
   * cleaner of its own rather than something done once when text arrives. A marker
   * added next month cleans every article already in the cache, with no re-sync and
   * nothing invalidated.
   *
   * Sanitising is last and unconditional. Instapaper's text is third-party HTML and
   * the fact that it arrives through an API we trust does not make its contents
   * trustworthy; running it once per article rather than once per render is also the
   * difference between a smooth reflow and a stutter.
   *
   * `externalHref` rather than the URL directly: it comes from Instapaper, it never
   * passes through DOMPurify on this path, and React will render a `javascript:` href
   * without complaint.
   */
  const origin = bookmark === undefined ? null : externalHref(bookmark.url);
  const clean = useMemo(
    () => (html === undefined ? '' : sanitizeArticle(removeFurniture(html))),
    [html],
  );
  const ready = clean !== '';

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
   * Archive and delete.
   *
   * Leaving the article is unconditional now, and that is the point of the queue:
   * the mark is on disk before the request goes out, so a reader on a train gets the
   * same behaviour as one on wifi and the send happens whenever it can. The only
   * outcome that changes what happens next is the gate having lapsed — which is not
   * a fact about this article, and is answered by the unlock screen rather than by an
   * error banner.
   */
  function run(promise: Promise<FlushResult>, what: string) {
    setError(null);
    promise
      .then((result) => {
        navigate(result.unauthorized ? '/unlock' : '/', { replace: result.unauthorized });
      })
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
        ) : isError && online ? (
          <p className={styles.notice} role="alert">
            The article could not be fetched. It may be worth trying again from the front page.
          </p>
        ) : !ready || isError ? (
          /*
           * No text — and the reason matters, because there are two of them and the
           * reader can act on only one.
           *
           * Offline, this article simply has not been fetched yet, and saying "a
           * paywall, a video page, or a PDF" is a confident diagnosis of the wrong
           * thing: the article may be perfectly ordinary and one connection away. The
           * offer of a fetch is wrong there too — it cannot work, and a button that
           * cannot work is worse than no button.
           *
           * Note the condition, which the browser run corrected: with no network the
           * text query *throws* rather than returning nothing, so an un-downloaded
           * article arrives here as `isError` and not as `!ready`. Both land in this
           * branch when offline, and "could not be fetched, try again from the front
           * page" is kept for the case where there is a network and it genuinely
           * failed.
           */
          <div className={styles.notice}>
            {online ? (
              <>
                <p>Instapaper has no text for this one — a paywall, a video page, or a PDF.</p>
                {origin !== null && (
                  <p>
                    <a
                      className={styles.action}
                      href={origin}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      Open at the publisher
                    </a>
                  </p>
                )}
              </>
            ) : (
              <>
                <p>This one has not been downloaded yet, and you are offline.</p>
                <p className={styles.muted}>
                  Articles you have already opened are readable without a network. This one will
                  load the next time you have one.
                </p>
              </>
            )}
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
            {bookmark && (
              <header className={styles.headline}>
                {!titleIsInText && (bookmark.title || '').trim() !== '' && (
                  <h1 className={styles.headlineText}>{bookmark.title}</h1>
                )}
                {/*
                  Where the text came from, and a way out to the page it came from.

                  It renders unconditionally, and that is deliberate: it used to come
                  with the headline, which meant a publisher whose `get_text` keeps
                  its own `<h1>` got no line at all — and those are exactly the
                  articles where "where did this text come from?" is hardest to
                  answer. An indicator that appears only when something else is also
                  true is not an indicator.

                  There is one source of text again, so the line no longer has to say
                  which of two it is. The link is the part that earns its place: the
                  reading view is a cleaned copy of someone else's page, and going to
                  see the original is a thing readers want often enough that
                  Instapaper puts it in its own interface.
                */}
                <p className={styles.byline}>
                  {origin === null ? (
                    hostOf(bookmark.url)
                  ) : (
                    <a
                      className={styles.origin}
                      href={origin}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {hostOf(bookmark.url)}
                    </a>
                  )}
                  <span className={styles.provenance}> · Text from Instapaper</span>
                </p>
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
