import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import {
  ApiError,
  useBookmarkAction,
  useImageCache,
  useResolveImages,
  useSync,
  useUnreadBookmarks,
} from '../lib/queries';
import styles from './FrontPage.module.css';

/**
 * The Phase 3 scaffold: a plain list, so the data layer is demonstrable.
 *
 * Phase 5 replaces this entirely with the newspaper layout — hero, three secondary
 * cards, and the two sidebar lists. This exists to prove the round trip works and
 * that archiving here shows up in Instapaper, which is the phase's "done when". It
 * is deliberately plain rather than a half-built version of the real thing.
 *
 * Phase 4 added the thumbnails, for the same reason and with the same restraint:
 * seeing a resolved `og:image` next to a row is what makes the resolution pass
 * demonstrable. The slot rules that decide which four articles get a picture are
 * Phase 5's, not here.
 */
export function FrontPage() {
  const navigate = useNavigate();
  const { data: bookmarks, isLoading } = useUnreadBookmarks();
  const { data: images } = useImageCache();
  const sync = useSync();
  const resolve = useResolveImages();
  const archive = useBookmarkAction('archive');
  const remove = useBookmarkAction('delete');
  const [error, setError] = useState<string | null>(null);

  // An expired session is the gate's business, not an error to render.
  const failed = sync.error ?? archive.error ?? remove.error ?? resolve.error;
  useEffect(() => {
    if (failed instanceof ApiError && failed.status === 401) navigate('/unlock', { replace: true });
  }, [failed, navigate]);

  // Resolution runs behind the list rather than in front of it: the articles are
  // readable the moment they arrive, and the pictures fill in after. It is safe to
  // fire on every list change because a URL with a cached answer costs no request.
  const startResolving = resolve.mutate;
  useEffect(() => {
    if (!bookmarks || bookmarks.length === 0) return;
    startResolving(bookmarks.map((bookmark) => bookmark.url));
  }, [bookmarks, startResolving]);

  const busy = sync.isPending || archive.isPending || remove.isPending;

  function run(promise: Promise<unknown>, what: string) {
    setError(null);
    promise.catch((cause: unknown) => {
      setError(`Could not ${what}: ${cause instanceof Error ? cause.message : 'unknown error'}`);
    });
  }

  return (
    <div className={styles.wrap}>
      <div className={styles.head}>
        <div>
          <p className={styles.phase}>Phase 3 scaffold</p>
          <h1 className={styles.title}>Unread</h1>
        </div>
        <button
          type="button"
          className={styles.sync}
          disabled={busy}
          onClick={() => run(sync.mutateAsync(), 'sync')}
        >
          {sync.isPending ? 'Syncing…' : 'Sync'}
        </button>
      </div>

      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}

      {isLoading ? (
        <p className={styles.muted}>Reading the local cache…</p>
      ) : !bookmarks || bookmarks.length === 0 ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>Nothing unread.</p>
          <p className={styles.muted}>
            {sync.isSuccess
              ? 'Instapaper returned an empty unread folder.'
              : 'Press Sync to fetch your unread folder from Instapaper.'}
          </p>
        </div>
      ) : (
        <>
          <p className={styles.count}>
            {bookmarks.length} article{bookmarks.length === 1 ? '' : 's'}
          </p>
          <ul className={styles.list}>
            {bookmarks.map((bookmark) => (
              <li key={bookmark.bookmark_id} className={styles.item}>
                {images?.get(bookmark.url)?.image_url ? (
                  <img
                    className={styles.thumb}
                    src={images.get(bookmark.url)?.image_url ?? ''}
                    alt=""
                    loading="lazy"
                    // A publisher's image that 404s must leave a gap, not a broken
                    // icon; the row is about the article, not the picture.
                    onError={(event) => {
                      event.currentTarget.style.visibility = 'hidden';
                    }}
                  />
                ) : (
                  <span className={styles.thumbEmpty} aria-hidden="true" />
                )}
                <div className={styles.itemText}>
                  <a
                    className={styles.itemTitle}
                    href={bookmark.url}
                    target="_blank"
                    rel="noreferrer noopener"
                  >
                    {bookmark.title || bookmark.url}
                  </a>
                  <p className={styles.itemMeta}>{hostOf(bookmark.url)}</p>
                </div>
                <div className={styles.actions}>
                  <button
                    type="button"
                    className={styles.action}
                    disabled={busy}
                    onClick={() => run(archive.mutateAsync(bookmark.bookmark_id), 'archive')}
                  >
                    Archive
                  </button>
                  <button
                    type="button"
                    className={styles.danger}
                    disabled={busy}
                    onClick={() => {
                      // Irreversible at Instapaper — there is no undo on their side.
                      if (!confirm(`Delete "${bookmark.title || bookmark.url}" permanently?`))
                        return;
                      run(remove.mutateAsync(bookmark.bookmark_id), 'delete');
                    }}
                  >
                    Delete
                  </button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '');
  } catch {
    return url;
  }
}
