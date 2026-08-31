import { Placeholder } from '../components/Placeholder';

/**
 * Rendered outside AppLayout — this is the one route reachable without a session,
 * so it must not depend on chrome that assumes one.
 */
export function Unlock() {
  return (
    <main
      style={{ padding: 'var(--space-16) var(--space-6)', maxWidth: '72rem', margin: '0 auto' }}
    >
      <Placeholder title="Unlock" phase="Phase 2">
        <p>
          A passphrase field, checked against <code>STASH_PASSPHRASE</code> in constant time and
          exchanged for a signed httpOnly session cookie.
        </p>
        <p>
          This gate is the only thing between a public URL and an account someone can delete
          bookmarks from, so it lands before the first deploy — not after.
        </p>
      </Placeholder>
    </main>
  );
}
