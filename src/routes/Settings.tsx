import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import styles from './Settings.module.css';

interface Status {
  connected: boolean;
  username?: string;
  reason?: 'not_configured' | 'rejected' | 'timeout' | 'error';
  detail?: string;
}

/** What each failure actually means, and what the operator does about it. */
const EXPLANATION: Record<string, string> = {
  not_configured: 'The Instapaper environment variables are not all set on this deployment.',
  rejected:
    'Instapaper rejected the stored token. It may have been revoked — run `npm run connect` again and replace the two token variables.',
  timeout: 'Instapaper did not respond in time. This is usually temporary.',
  // Deliberately not "could not reach Instapaper": a DNS failure, a TLS failure and
  // a bug in our own code all arrive here, and naming one of them sends the reader
  // to check their network when the fault may be ours. The detail line below says
  // what actually happened.
  error: 'The call to Instapaper did not complete. What went wrong:',
};

export function Settings() {
  const navigate = useNavigate();
  const [status, setStatus] = useState<Status | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const cancelled = { current: false };

    void (async () => {
      try {
        const response = await fetch('/api/status');
        // An expired session lands here; the gate is the answer, not an error.
        if (response.status === 401) {
          navigate('/unlock', { replace: true });
          return;
        }
        const body = (await response.json()) as Status;
        if (!cancelled.current) setStatus(body);
      } catch {
        if (!cancelled.current) setFailed(true);
      }
    })();

    return () => {
      cancelled.current = true;
    };
  }, [navigate]);

  async function signOut() {
    await fetch('/api/unlock', { method: 'DELETE' });
    navigate('/unlock', { replace: true });
  }

  return (
    <div className={styles.wrap}>
      <h1 className={styles.title}>Settings</h1>

      <section className={styles.section}>
        <h2 className={styles.heading}>Instapaper</h2>

        {failed ? (
          <p className={styles.bad}>Could not check the connection.</p>
        ) : status === null ? (
          <p className={styles.muted}>Checking…</p>
        ) : status.connected ? (
          <p className={styles.good}>Connected{status.username ? ` as ${status.username}` : ''}.</p>
        ) : (
          <>
            <p className={styles.bad}>Not connected.</p>
            <p className={styles.muted}>
              {EXPLANATION[status.reason ?? 'error'] ?? EXPLANATION.error}
            </p>
            {status.detail && <p className={styles.detail}>{status.detail}</p>}
          </>
        )}

        <p className={styles.note}>
          Reconnecting means running <code>npm run connect</code> on your own machine and pasting
          the new token into this deployment&rsquo;s environment variables. There is deliberately no
          way to do it from here — the deployed app has no path that writes credentials, and never
          sees your password.
        </p>
      </section>

      <section className={styles.section}>
        <h2 className={styles.heading}>This device</h2>
        <button className={styles.button} type="button" onClick={() => void signOut()}>
          Sign out
        </button>
        <p className={styles.note}>
          Clears the session cookie on this device. The passphrase is unchanged.
        </p>
      </section>

      <section className={styles.section}>
        <h2 className={styles.heading}>Still to come</h2>
        <p className={styles.muted}>
          Appearance, cache size and clear-cache arrive with Phase 9. Publisher sessions arrive with
          Phase 7b.
        </p>
      </section>
    </div>
  );
}
