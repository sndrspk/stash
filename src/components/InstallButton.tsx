import { useInstallPrompt } from '../hooks/useInstallPrompt';
import styles from './InstallButton.module.css';

/**
 * Renders nothing unless the browser has actually offered an install prompt.
 * Storage persistence depends on being installed, so this is worth surfacing —
 * but a dead button on iOS would be worse than none.
 */
export function InstallButton() {
  const { available, promptInstall } = useInstallPrompt();
  if (!available) return null;

  return (
    <button type="button" className={styles.button} onClick={() => void promptInstall()}>
      Install
    </button>
  );
}
