import { Link, Outlet, useLocation } from 'react-router-dom';

import { InstallButton } from './components/InstallButton';
import { versionLabel } from './lib/version';
import styles from './AppLayout.module.css';

/**
 * The shell every signed-in route renders inside.
 *
 * The reading view opts out of the masthead — Phase 6 owns the full viewport for
 * column measurement, and a header competing for height is exactly what breaks it.
 */
export function AppLayout() {
  const { pathname } = useLocation();
  const isReading = pathname.startsWith('/read/');

  return (
    <div className={styles.shell}>
      {!isReading && (
        <header className={styles.masthead}>
          {/*
            The build number sits beside the wordmark, not inside the link.

            Inside, it would be part of the click target for "go home" — a reader
            aiming at a version string and landing on the front page. It is a label,
            not a destination.

            The question it answers is "am I running the change that was merged?",
            asked while looking at the thing that still seems wrong. An answer two
            screens away in settings is one nobody goes and gets, which is why it is
            here and not there. It costs a `<div>` around the two, so the masthead's
            `space-between` still puts this group left and the nav right.
          */}
          <div className={styles.brand}>
            <Link to="/" className={styles.wordmark}>
              Stash
            </Link>
            <span className={styles.version} title="The build this page came from">
              {versionLabel()}
            </span>
          </div>
          <nav className={styles.nav}>
            <InstallButton />
            <Link to="/settings" className={styles.navLink}>
              Settings
            </Link>
          </nav>
        </header>
      )}
      <main className={isReading ? styles.mainBare : styles.main}>
        <Outlet />
      </main>
    </div>
  );
}
