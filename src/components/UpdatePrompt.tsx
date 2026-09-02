import { useRegisterSW } from 'virtual:pwa-register/react';

import styles from './UpdatePrompt.module.css';

/**
 * Registers the service worker, and offers the new version rather than imposing it.
 *
 * `registerType: 'prompt'` in `vite.config.ts` is half of a decision that only works
 * if something completes it: without a caller for `updateServiceWorker`, a new build
 * installs, waits, and never activates — the reader stays on an old version forever
 * and nothing says so. This is that caller.
 *
 * **Why prompt rather than `autoUpdate`.** An automatic update swaps the assets under
 * a live page, and this page is one someone is reading. In paged mode the reflow
 * would move them to a different column mid-sentence; in either mode a chunk fetched
 * after the swap can 404 against the new build, which surfaces as a blank screen
 * rather than as an update. The cost of asking is one line at the foot of the screen.
 *
 * The banner is deliberately dismissible and deliberately not modal. There is nothing
 * urgent about a new build of a reading app, and an update prompt that blocks the
 * article is worse than the version it is offering to replace.
 */
export function UpdatePrompt() {
  const {
    needRefresh: [needRefresh, setNeedRefresh],
    updateServiceWorker,
  } = useRegisterSW({
    onRegisteredSW(url, registration) {
      /*
       * Look for a new build when the app is opened, not only when the browser
       * happens to check.
       *
       * An installed PWA can run for weeks without a navigation, which is precisely
       * the case where the browser's own update check is least likely to have fired.
       * One conditional GET of the worker script is a cheap thing to spend on that.
       */
      if (registration === undefined) return;
      void registration.update().catch(() => {
        // Offline, or the server is down. Neither is worth reporting: the app is
        // already running from the cache and this was only a check.
      });
    },
  });

  if (!needRefresh) return null;

  return (
    <div className={styles.bar} role="status">
      <span className={styles.text}>A new version of Stash is ready.</span>
      <button
        type="button"
        className={styles.primary}
        onClick={() => void updateServiceWorker(true)}
      >
        Reload
      </button>
      <button type="button" className={styles.dismiss} onClick={() => setNeedRefresh(false)}>
        Later
      </button>
    </div>
  );
}
