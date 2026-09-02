import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { useOnline } from '../hooks/useOnline';
import { usePullToRefresh } from '../hooks/usePullToRefresh';
import type { BookmarkRecord, ImageCacheRecord } from '../lib/db';
import {
  CARD_EXCERPT_CHARS,
  HERO_EXCERPT_CHARS,
  chooseSlots,
  excerptFor,
  needsExcerptText,
} from '../lib/front-page';
import {
  ApiError,
  useEnsureText,
  useImageCache,
  usePendingActions,
  useResolveImages,
  useSync,
  useTextFor,
  useUnreadBookmarks,
} from '../lib/queries';
import styles from './FrontPage.module.css';

/**
 * The front page: a newspaper, not a list.
 *
 * One lead story with its picture and an excerpt, three more below it, and two
 * title-only columns of what else is waiting. Which article lands where is decided
 * in `lib/front-page.ts`; this file is the rendering, the states, and the two ways
 * to ask for a refresh.
 *
 * The one rule visible from here: **an image slot never holds an article without a
 * picture.** A slot with a blank rectangle in it is worse than a slot that is not
 * there, so when the queue cannot fill four the grid simply has fewer.
 */
export function FrontPage() {
  const navigate = useNavigate();
  const { data: bookmarks, isLoading } = useUnreadBookmarks();
  const { data: images } = useImageCache();
  const sync = useSync();
  const resolve = useResolveImages();
  const { data: pending } = usePendingActions();
  const online = useOnline();
  const ensureText = useEnsureText();
  const [error, setError] = useState<string | null>(null);

  /*
   * The shuffle seed.
   *
   * Held in state rather than recomputed, because the page must not reshuffle every
   * time a resolved image or a fetched excerpt lands — the reader would watch the
   * lead story change while reading its first sentence. It advances on an explicit
   * refresh, which is what "reshuffles on refresh" means.
   */
  const [seed, setSeed] = useState(() => Date.now());

  const slots = useMemo(
    () => chooseSlots(bookmarks ?? [], images ?? new Map<string, ImageCacheRecord>(), seed),
    [bookmarks, images, seed],
  );

  const wantsText = useMemo(() => needsExcerptText(slots), [slots]);
  const { data: texts } = useTextFor(wantsText.map((bookmark) => bookmark.bookmark_id));

  // An expired session is the gate's business, not an error to render.
  const failed = sync.error ?? resolve.error ?? ensureText.error;
  useEffect(() => {
    if (failed instanceof ApiError && failed.status === 401) navigate('/unlock', { replace: true });
  }, [failed, navigate]);

  // Images resolve behind the page: the articles are readable the moment they
  // arrive and the pictures fill in after. A URL with a cached answer costs no
  // request, so firing on every list change is free.
  const startResolving = resolve.mutate;
  useEffect(() => {
    if (!bookmarks || bookmarks.length === 0) return;
    startResolving(bookmarks.map((bookmark) => bookmark.url));
  }, [bookmarks, startResolving]);

  // Only the slot articles with no description, and only ever four.
  const startFetchingText = ensureText.mutate;
  useEffect(() => {
    if (wantsText.length === 0) return;
    startFetchingText(wantsText);
  }, [wantsText, startFetchingText]);

  function refresh() {
    setError(null);
    sync
      .mutateAsync()
      .then(() => setSeed(Date.now()))
      .catch((cause: unknown) => {
        setError(`Could not sync: ${cause instanceof Error ? cause.message : 'unknown error'}`);
      });
  }

  const pull = usePullToRefresh(refresh, !sync.isPending);

  const excerpt = (bookmark: BookmarkRecord, max: number) =>
    excerptFor(bookmark, texts?.get(bookmark.bookmark_id), max);

  const imageFor = (bookmark: BookmarkRecord) => images?.get(bookmark.url)?.image_url ?? null;

  // Nothing has a picture *yet* is a loading state; nothing has a picture *at all*
  // is a real front page with no photographs on it. The difference is whether the
  // resolution pass has finished — and a pass that failed has finished too, or the
  // hero slot would show a skeleton for as long as the app stayed open.
  const awaitingImages = slots.illustrated === 0 && !resolve.isSuccess && !resolve.isError;

  return (
    <div className={styles.page}>
      <div
        className={styles.pull}
        style={{ height: pull.distance }}
        aria-hidden={pull.distance === 0}
      >
        {pull.distance > 0 && (
          <span className={styles.pullLabel}>
            {pull.armed ? 'Release to refresh' : 'Pull to refresh'}
          </span>
        )}
      </div>

      <header className={styles.masthead}>
        <div>
          <p className={styles.dateline}>
            {new Date().toLocaleDateString(undefined, {
              weekday: 'long',
              day: 'numeric',
              month: 'long',
            })}
          </p>
          <h1 className={styles.title}>Unread</h1>
        </div>
        <button
          type="button"
          className={styles.refresh}
          disabled={sync.isPending}
          onClick={refresh}
        >
          {sync.isPending ? 'Syncing…' : 'Refresh'}
        </button>
      </header>

      {error !== null && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      {/*
        What has not reached Instapaper yet.

        Worth a line on the front page rather than a silent retry, because the article
        is already gone from this screen: without it, "I archived that on the train"
        and "Instapaper knows I archived that" are indistinguishable until you open
        Instapaper somewhere else. It says nothing at all when the queue is empty,
        which is almost always.
      */}
      {pending !== undefined && pending.length > 0 && (
        <p className={styles.pending}>
          {pending.length === 1
            ? '1 action is waiting to reach Instapaper'
            : `${String(pending.length)} actions are waiting to reach Instapaper`}
          {online
            ? ' — sending…'
            : pending.length === 1
              ? ' — it will be sent when you are back online.'
              : ' — they will be sent when you are back online.'}
        </p>
      )}

      {isLoading ? (
        <FrontPageSkeleton />
      ) : !bookmarks || bookmarks.length === 0 ? (
        <EmptyQueue synced={sync.isSuccess} onRefresh={refresh} busy={sync.isPending} />
      ) : (
        <div className={styles.grid}>
          <div className={styles.stories}>
            {slots.hero !== null ? (
              <Hero
                bookmark={slots.hero}
                image={imageFor(slots.hero)}
                excerpt={excerpt(slots.hero, HERO_EXCERPT_CHARS)}
              />
            ) : awaitingImages ? (
              <div className={`${styles.hero} ${styles.skeleton}`} aria-hidden="true">
                <div className={styles.skeletonImage} />
                <div className={styles.skeletonLine} />
                <div className={styles.skeletonLineShort} />
              </div>
            ) : null}

            {slots.secondaries.length > 0 && (
              <div className={styles.cards}>
                {slots.secondaries.map((bookmark) => (
                  <Card
                    key={bookmark.bookmark_id}
                    bookmark={bookmark}
                    image={imageFor(bookmark)}
                    excerpt={excerpt(bookmark, CARD_EXCERPT_CHARS)}
                  />
                ))}
              </div>
            )}

            {slots.hero === null && !awaitingImages && (
              <p className={styles.noPictures}>
                Nothing unread has a picture today, so the front page is all columns.
              </p>
            )}
          </div>

          <aside className={styles.sidebar}>
            <TitleList heading="Newest" bookmarks={slots.newest} />
            <TitleList heading="Oldest" bookmarks={slots.oldest} />
            {slots.newest.length === 0 && slots.oldest.length === 0 && (
              <p className={styles.muted}>Everything unread is on the front page.</p>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

function Hero({
  bookmark,
  image,
  excerpt,
}: {
  bookmark: BookmarkRecord;
  image: string | null;
  excerpt: string;
}) {
  return (
    <article className={styles.hero}>
      <Link to={`/read/${bookmark.bookmark_id}`} className={styles.heroLink}>
        {image !== null && (
          <img className={styles.heroImage} src={image} alt="" onError={hideBrokenImage} />
        )}
        <h2 className={styles.heroTitle}>{bookmark.title || bookmark.url}</h2>
      </Link>
      <p className={styles.source}>{hostOf(bookmark.url)}</p>
      {excerpt !== '' && <p className={styles.heroExcerpt}>{excerpt}</p>}
    </article>
  );
}

function Card({
  bookmark,
  image,
  excerpt,
}: {
  bookmark: BookmarkRecord;
  image: string | null;
  excerpt: string;
}) {
  return (
    <article className={styles.card}>
      <Link to={`/read/${bookmark.bookmark_id}`} className={styles.cardLink}>
        {image !== null && (
          <img
            className={styles.cardImage}
            src={image}
            alt=""
            loading="lazy"
            onError={hideBrokenImage}
          />
        )}
        <h3 className={styles.cardTitle}>{bookmark.title || bookmark.url}</h3>
      </Link>
      <p className={styles.source}>{hostOf(bookmark.url)}</p>
      {excerpt !== '' && <p className={styles.cardExcerpt}>{excerpt}</p>}
    </article>
  );
}

function TitleList({ heading, bookmarks }: { heading: string; bookmarks: BookmarkRecord[] }) {
  if (bookmarks.length === 0) return null;
  return (
    <section className={styles.list}>
      <h2 className={styles.listHeading}>{heading}</h2>
      <ul className={styles.listItems}>
        {bookmarks.map((bookmark) => (
          <li key={bookmark.bookmark_id} className={styles.listItem}>
            <Link to={`/read/${bookmark.bookmark_id}`} className={styles.listLink}>
              {bookmark.title || bookmark.url}
            </Link>
            <span className={styles.listSource}>{hostOf(bookmark.url)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Zero unread is a real state, not an error, and it is the state a reader who has
 * caught up has earned. It says so, and offers the one useful action.
 */
function EmptyQueue({
  synced,
  onRefresh,
  busy,
}: {
  synced: boolean;
  onRefresh: () => void;
  busy: boolean;
}) {
  return (
    <div className={styles.empty}>
      <p className={styles.emptyTitle}>{synced ? 'You’re all caught up.' : 'Nothing here yet.'}</p>
      <p className={styles.muted}>
        {synced
          ? 'Nothing is waiting in your unread folder. Save something to Instapaper and refresh.'
          : 'Refresh to fetch your unread folder from Instapaper.'}
      </p>
      <button type="button" className={styles.refresh} disabled={busy} onClick={onRefresh}>
        {busy ? 'Syncing…' : 'Refresh'}
      </button>
    </div>
  );
}

/** The shape of the page, before there is a page. */
function FrontPageSkeleton() {
  return (
    <div className={styles.grid} aria-hidden="true">
      <div className={styles.stories}>
        <div className={`${styles.hero} ${styles.skeleton}`}>
          <div className={styles.skeletonImage} />
          <div className={styles.skeletonLine} />
          <div className={styles.skeletonLineShort} />
        </div>
        <div className={styles.cards}>
          {[0, 1, 2].map((i) => (
            <div key={i} className={`${styles.card} ${styles.skeleton}`}>
              <div className={styles.skeletonCardImage} />
              <div className={styles.skeletonLine} />
            </div>
          ))}
        </div>
      </div>
      <aside className={styles.sidebar}>
        {[0, 1].map((i) => (
          <div key={i} className={styles.list}>
            <div className={styles.skeletonLineShort} />
            {[0, 1, 2, 3, 4].map((j) => (
              <div key={j} className={styles.skeletonLine} />
            ))}
          </div>
        ))}
      </aside>
    </div>
  );
}

/** A publisher's image that 404s must leave a gap, not a broken-image icon. */
function hideBrokenImage(event: React.SyntheticEvent<HTMLImageElement>) {
  event.currentTarget.style.display = 'none';
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
