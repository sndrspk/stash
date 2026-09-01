import { Link, useNavigate, useParams } from 'react-router-dom';
import { useState } from 'react';

import { Placeholder } from '../components/Placeholder';
import { useBookmark, useBookmarkAction } from '../lib/queries';

/**
 * Still Phase 6's screen, with one thing borrowed forward.
 *
 * Archive and delete belong to the reading view per the spec, and Phase 5 took them
 * off the front page when it replaced the scaffold's list. Rather than leave the app
 * with no way to archive anything until Phase 6 lands, they live here now — plainly,
 * with no reading view around them yet.
 */
export function Reader() {
  const { bookmarkId } = useParams<{ bookmarkId: string }>();
  const navigate = useNavigate();
  const id = Number(bookmarkId);
  const { data: bookmark } = useBookmark(id);

  const archive = useBookmarkAction('archive');
  const remove = useBookmarkAction('delete');
  const [error, setError] = useState<string | null>(null);
  const busy = archive.isPending || remove.isPending;

  function run(promise: Promise<unknown>, what: string) {
    setError(null);
    promise
      .then(() => navigate('/'))
      .catch((cause: unknown) => {
        setError(`Could not ${what}: ${cause instanceof Error ? cause.message : 'unknown error'}`);
      });
  }

  return (
    <div style={{ padding: 'var(--space-8) var(--space-6)' }}>
      <Placeholder title="The reading view" phase="Phase 6">
        <p>
          {bookmark ? (
            <strong>{bookmark.title || bookmark.url}</strong>
          ) : (
            <>
              Bookmark <code>{bookmarkId}</code>
            </>
          )}
          . Horizontally paginated multi-column text with the deterministic column-count algorithm,
          snap-to-column, and live typography preferences.
        </p>

        {error !== null && <p role="alert">{error}</p>}

        {Number.isInteger(id) && id > 0 && (
          <p style={{ display: 'flex', gap: 'var(--space-3)' }}>
            <button
              type="button"
              disabled={busy}
              onClick={() => run(archive.mutateAsync(id), 'archive')}
            >
              Archive
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                // Irreversible at Instapaper — there is no undo on their side.
                if (!confirm(`Delete "${bookmark?.title || bookmarkId}" permanently?`)) return;
                run(remove.mutateAsync(id), 'delete');
              }}
            >
              Delete
            </button>
          </p>
        )}

        <p>
          <Link to="/">Back to the front page</Link>
        </p>
      </Placeholder>
    </div>
  );
}
