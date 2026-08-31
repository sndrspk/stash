import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';

import styles from './Unlock.module.css';

/**
 * The passphrase gate.
 *
 * Rendered outside AppLayout — this is the one route reachable without a session,
 * so it must not depend on chrome that assumes one.
 *
 * The passphrase is never held anywhere but this component's state: the server
 * answers with an httpOnly cookie, which script cannot read, so there is nothing
 * to persist here and nothing for injected article HTML to steal later.
 */
export function Unlock() {
  const navigate = useNavigate();
  const [passphrase, setPassphrase] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (busy || !passphrase) return;

    setBusy(true);
    setError(null);

    try {
      const response = await fetch('/api/unlock', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ passphrase }),
      });

      if (response.ok) {
        setPassphrase('');
        navigate('/', { replace: true });
        return;
      }

      // Each message says what happened and what to do about it. "Something went
      // wrong" would be true of all of them and useful for none.
      if (response.status === 429) {
        const wait = response.headers.get('retry-after');
        setError(`Too many attempts. Try again in ${wait ?? '60'} seconds.`);
      } else if (response.status === 503) {
        setError('This deployment has no passphrase set. Add STASH_PASSPHRASE and redeploy.');
      } else {
        setError('That passphrase is not right.');
      }
    } catch {
      setError('Could not reach the server. Check your connection and try again.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className={styles.wrap}>
      <form className={styles.card} onSubmit={onSubmit}>
        <h1 className={styles.title}>Stash</h1>
        <p className={styles.blurb}>Enter the passphrase for this deployment.</p>

        <label className={styles.label} htmlFor="passphrase">
          Passphrase
        </label>
        <input
          id="passphrase"
          className={styles.input}
          type="password"
          value={passphrase}
          onChange={(e) => setPassphrase(e.target.value)}
          autoComplete="current-password"
          autoFocus
          disabled={busy}
          aria-describedby={error ? 'unlock-error' : undefined}
          aria-invalid={error !== null}
        />

        {/* aria-live so the message is announced, not just drawn. */}
        <p id="unlock-error" className={styles.error} role="alert" aria-live="polite">
          {error ?? ' '}
        </p>

        <button className={styles.button} type="submit" disabled={busy || !passphrase}>
          {busy ? 'Checking…' : 'Unlock'}
        </button>
      </form>
    </main>
  );
}
