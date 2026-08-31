import { Link, Outlet, useLocation } from 'react-router-dom';

import { InstallButton } from './components/InstallButton';
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
          <Link to="/" className={styles.wordmark}>
            Stash
          </Link>
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
