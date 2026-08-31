import { Link, useParams } from 'react-router-dom';

import { Placeholder } from '../components/Placeholder';

export function Reader() {
  const { bookmarkId } = useParams<{ bookmarkId: string }>();

  return (
    <div style={{ padding: 'var(--space-8) var(--space-6)' }}>
      <Placeholder title="The reading view" phase="Phase 6">
        <p>
          Bookmark <code>{bookmarkId}</code>. Horizontally paginated multi-column text with the
          deterministic column-count algorithm, snap-to-column, and live typography preferences.
        </p>
        <p>
          <Link to="/">Back to the front page</Link>
        </p>
      </Placeholder>
    </div>
  );
}
