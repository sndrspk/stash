import { Placeholder } from '../components/Placeholder';

export function Settings() {
  return (
    <Placeholder title="Settings" phase="Phases 2, 7b and 9">
      <p>
        Connection status, appearance, cache size and clear-cache. Reconnecting means re-running{' '}
        <code>npm run connect</code> locally — there is deliberately no in-app credential write
        path.
      </p>
      <p>Publisher sessions (add a host, paste a cookie header, sign out) arrive with Phase 7b.</p>
    </Placeholder>
  );
}
