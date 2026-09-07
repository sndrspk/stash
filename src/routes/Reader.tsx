import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';

import { TypographyPanel } from '../components/TypographyPanel';
import { useColumnLayout } from '../hooks/useColumnLayout';
import { useColumnSnap } from '../hooks/useColumnSnap';
import { useOnline } from '../hooks/useOnline';
import type { BookmarkRecord } from '../lib/db';
import { needsExtraction } from '../lib/extraction';
import { removeFurniture } from '../lib/furniture';
import type { FlushResult } from '../lib/pending';
import { prefsToCss, DEFAULT_PREFS, resolveReadingMode } from '../lib/prefs';
import { externalHref } from '../lib/sanitize';
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

  /*
   * Where the text on screen came from, and a way out to the page it came from.
   *
   * `readBestText` prefers our extraction over Instapaper's, silently and correctly —
   * but silently means a reader comparing this against the publisher's own page has no
   * way to know which of the two they are looking at, and no way to tell "Instapaper
   * dropped the standfirst" from "our extractor did". That distinction cost a session's
   * worth of debugging on an article whose intro was missing.
   *
   * `externalHref` rather than the URL directly: it comes from Instapaper, it never
   * passes through DOMPurify on this path, and React will render a `javascript:` href
   * without complaint.
   */
  const usingExtraction = sources?.extracted != null && !showOriginal;
  /*
   * "Extracted by Stash" alone could not answer the question it was added for.
   *
   * Plenty of soft paywalls yield to an anonymous fetch, so an extraction that
   * succeeded says nothing about whether the reader's session did the work — and
   * "did my session do the work?" is exactly what someone asks when deciding whether
   * pasting one was worth it. The server is the only party that knows, since it is
   * the only one that sees the jar; `authenticated` is its answer, stored beside the
   * text so the question can be asked days later rather than only in the second
   * after the fetch.
   *
   * Silent when unrecorded. Rows written before the field existed have no answer,
   * and saying "anonymously" about a fetch we cannot speak for would be a confident
   * claim built on an absent value.
   */
  const withSession = sources?.extractedAuthenticated;
  const provenance = usingExtraction
    ? withSession === undefined
      ? 'Extracted by Stash'
      : withSession
        ? 'Extracted by Stash, with your session'
        : 'Extracted by Stash, anonymously'
    : 'Text from Instapaper';
  const origin = bookmark === undefined ? null : externalHref(bookmark.url);
  const clean = useMemo(
    () => (shown === undefined ? '' : sanitizeArticle(removeFurniture(shown))),
    [shown],
  );
  const ready = clean !== '';

  /*
   * Whether to offer "fetch full content".
   *
   * The question is about **what is on screen**, not about what is in the cache, and
   * the difference is the whole point. Keyed on "there is no extraction yet", the
   * button vanished the moment a stub extraction was stored — so an article that had
   * been fetched once and come back paywalled offered no way to try again, which is
   * exactly the article a reader has just gone and pasted a session for. Asked this
   * way, the offer stands for as long as the reader is looking at a stub.
   *
   * It costs nothing when there is nothing to do: `force` is absent from the automatic
   * pass below, so a stored extraction still short-circuits on the already-extracted
   * gate rather than fetching. `needsExtraction` is the same function `extraction.ts`
   * uses, so the button and the gate cannot disagree about what a stub is.
   *
   * `textLoaded` is not decoration. Without it the first render — before the query has
   * resolved — asks `needsExtraction(undefined)`, which is `true` by design, and the
   * automatic pass below fires for *every* article a reader opens. `extraction.ts`
   * re-checks against IndexedDB, but that row is written by this very query, so the
   * re-check reads nothing and agrees. The result is a fetch of the publisher's page
   * for a full article that never needed one, and an extraction stored beside text
   * that was fine. The browser run caught it as every fixture rendering the same
   * extracted text; "not loaded yet" and "is a stub" must not be the same answer.
   */
  const textLoaded = !isLoading && html !== undefined;
  const canExtract = bookmark !== undefined && textLoaded && needsExtraction(shown);

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

  /*
   * What the last extraction has to say for itself.
   *
   * Derived from the mutation rather than pushed into state by the button, because the
   * automatic pass produces exactly the same outcomes and a reader who never pressed
   * anything still deserves to be told that a session looks dead. The one thing that
   * *is* conditional on the button is the "nothing to fetch" line: the automatic pass
   * skips routinely and by design — backoff, already extracted, not truncated — and
   * announcing each of those would be noise on every second article.
   */
  const note = useMemo((): { text: string; sessions?: boolean } | null => {
    if (extract.isPending) return null;
    if (extract.error) {
      return { text: `Could not fetch: ${extract.error.message}` };
    }

    const outcome = extract.data?.outcome;
    const forced = extract.variables?.force === true;
    if (outcome == null) return forced ? { text: 'Nothing to fetch.' } : null;

    if (outcome.kind === 'blocked') return { text: `That page cannot be fetched: ${outcome.tag}.` };
    if (outcome.kind === 'failed') {
      /*
       * Whether cookies went out is the whole of what separates two different
       * problems wearing the same status code.
       *
       * A 403 *with* a session is the publisher refusing us before the cookies were
       * ever considered — bot protection, which pasting a fresh session will not
       * touch. A 403 *without* one means nothing was stored for this host, and the
       * thing to look at is the session list and the name it is filed under. Saying
       * only "HTTP 403" sends a reader to re-paste a session that is working fine.
       */
      const how = outcome.authenticated
        ? ' Your session was sent, so this is the publisher refusing the request itself, not a session problem.'
        : ' No session was sent for this host — check Settings if you expected one.';
      /*
       * Only when it differs from the article's own URL, and then it is the most
       * useful sentence on the screen: a refusal at the page we asked for is the
       * publisher saying no, while a refusal somewhere else means we were sent there
       * — a consent wall, a login, a regional gate — and the status code is about
       * that page rather than about the article.
       */
      const landed =
        outcome.finalUrl !== null && bookmark !== undefined && outcome.finalUrl !== bookmark.url
          ? ` The request ended at ${outcome.finalUrl}, not at the article, so that is what refused it.`
          : '';
      return { text: `The publisher's page could not be read: ${outcome.tag}.${how}${landed}` };
    }
    if (!outcome.truncated) return null;

    /*
     * The expired-session diagnostic. Both branches are stubs; what separates them is
     * whether cookies were actually sent for this host, which only the server knows —
     * so it is the server that decides, and this only phrases it.
     */
    return outcome.sessionExpired
      ? {
          text: `The session for ${bookmark ? hostOf(bookmark.url) : 'this publisher'} may have expired — the page still came back as a stub with it. Nothing has been cleared; paste a fresh one to be sure.`,
          sessions: true,
        }
      : {
          text: 'Fetched, but it still looks like a stub — this publisher may want a signed-in session.',
          sessions: true,
        };
  }, [extract.isPending, extract.error, extract.data, extract.variables, bookmark]);

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
   * alike. What it reports is derived from the mutation below rather than set here,
   * because the automatic pass produces the same facts and they deserve the same line.
   */
  function runExtract(force: boolean) {
    extract
      .mutateAsync({ bookmark: bookmark as BookmarkRecord, force })
      .then((result) => {
        if (result.outcome?.kind === 'extracted') setShowOriginal(false);
      })
      .catch(() => {
        // Reported through `extract.error` in `note` below. Swallowed here only so an
        // offline click is not an unhandled rejection.
      });
  }

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
          {/*
            One control, three meanings, and always offered.

            "Full text" when what is on screen is a stub. "Re-extract" when an
            extraction is already stored. "Extract" when neither — Instapaper's copy
            looks complete and the reader wants ours anyway.

            That third case is the one that was missing, and hiding it was not a
            cosmetic choice. An article Instapaper returns complete could not be
            fetched at all: no stub, so no "Full text"; no stored extraction, so no
            "Re-extract". Which meant a reader could not test whether their publisher
            session does anything except on an article that happened to be a stub, and
            could not reach our extraction for an article Instapaper returned complete
            but imperfect — the missing-standfirst case — even knowing exactly what was
            wrong with it.

            The machinery was always willing: `force` skips the heuristic, the backoff
            and the already-extracted gate alike, which is the whole distinction from
            the automatic pass above. Only the button's visibility said no.

            It costs a fetch of the publisher's page when pressed, and nothing when
            not. That is the right trade for a control a reader reaches for
            deliberately, having already decided the copy on screen is not the one they
            want.
          */}
          {textLoaded && bookmark !== undefined && (
            <button
              type="button"
              className={styles.action}
              disabled={extract.isPending}
              onClick={() => runExtract(true)}
              title={
                canExtract
                  ? 'Fetch the full article from the publisher'
                  : sources?.extracted != null
                    ? 'Fetch it from the publisher again, replacing the stored copy'
                    : "Fetch the publisher's own page, even though Instapaper's copy looks complete"
              }
            >
              {extract.isPending
                ? 'Fetching…'
                : canExtract
                  ? 'Full text'
                  : sources?.extracted != null
                    ? 'Re-extract'
                    : 'Extract'}
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

      {/*
        One render site for the extraction note, above the article rather than inside
        the empty state. A stub that Instapaper *did* return text for renders as an
        article, so a note living in the empty state would be invisible in precisely
        the case the diagnostic exists for.
      */}
      {note !== null && (
        <p className={styles.note}>
          {note.text}
          {note.sessions === true && (
            <>
              {' '}
              <button type="button" className={styles.link} onClick={() => navigate('/settings')}>
                Publisher sessions
              </button>
            </>
          )}
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
                  The provenance line, and it renders unconditionally.

                  It used to come with the headline, which meant a publisher whose
                  `get_text` keeps its own `<h1>` got no line at all — and those are
                  exactly the articles where "where did this text come from?" is
                  hardest to answer, since the Original toggle is also absent when
                  there is no extraction to toggle to. Saying "Instapaper" only when
                  something else is also true is not an indicator.
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
                  <span className={styles.provenance}> · {provenance}</span>
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
