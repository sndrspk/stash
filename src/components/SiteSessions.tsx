import { useEffect, useState } from 'react';

import styles from './SiteSessions.module.css';

/**
 * The publisher-sessions screen: add one, list what is stored, sign out of one.
 *
 * The whole of `SESSIONS.md` step 3, moved off the command line. Two constraints shape
 * it, and both come from `docs/EXTRACTION.md`:
 *
 * - **Cookie values are never shown**, because they are never sent here. The server
 *   returns names; there is no request this component could make that would give it a
 *   value, which is a stronger guarantee than remembering not to render one.
 * - **Nothing is ever cleared automatically.** Signing out of a publisher is a button a
 *   person presses, and it confirms first — re-capturing a session means going back to
 *   a desktop, opening devtools and pasting again.
 *
 * The paste field is a `<textarea>` rather than an `<input>`: a cookie header is several
 * hundred characters and routinely arrives with a newline in it, and a single-line box
 * that silently swallows the tail would be the worst possible place to lose one.
 */

interface SessionRow {
  host: string;
  cookies: string[];
  updatedAt: number;
}

interface Listing {
  configured: boolean;
  hosts: SessionRow[];
  cleared: string[];
  detail?: string;
}

/**
 * How long ago a session was pasted, in days.
 *
 * Worth the four lines: age is the single most useful thing to know when a publisher
 * starts serving stubs again. A Cloudflare `cf_clearance` lasts hours, an ordinary
 * "keep me signed in" cookie lasts months, and "saved 94 days ago" answers "is this
 * likely to be the problem?" without anyone having to guess.
 */
function savedAgo(updatedAt: number, now = Date.now()): string {
  if (!Number.isFinite(updatedAt) || updatedAt <= 0) return '';
  const days = Math.floor((now - updatedAt) / 86_400_000);
  if (days < 1) return ', saved today';
  if (days === 1) return ', saved yesterday';
  return `, saved ${String(days)} days ago`;
}

export function SiteSessions() {
  const [listing, setListing] = useState<Listing | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [host, setHost] = useState('');
  const [cookie, setCookie] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; bad: boolean } | null>(null);
  /*
   * A counter rather than a `load()` the handlers await.
   *
   * Two writes in quick succession — save, then sign out — would otherwise leave two
   * reloads in flight with no ordering between them, and whichever answered last would
   * win regardless of which happened last. Bumping this instead means the effect's own
   * cleanup discards the earlier reply.
   */
  const [reloads, setReloads] = useState(0);

  useEffect(() => {
    const cancelled = { current: false };

    void (async () => {
      try {
        const response = await fetch('/api/sessions');
        if (cancelled.current) return;
        if (!response.ok) {
          const body = (await response.json().catch(() => ({}))) as { detail?: string };
          if (!cancelled.current) {
            setLoadError(
              body.detail ?? `The sessions store answered HTTP ${String(response.status)}.`,
            );
          }
          return;
        }
        const body = (await response.json()) as Listing;
        if (cancelled.current) return;
        setLoadError(null);
        setListing(body);
      } catch {
        if (!cancelled.current) setLoadError('Could not reach this deployment.');
      }
    })();

    return () => {
      cancelled.current = true;
    };
  }, [reloads]);

  async function add(event: React.FormEvent) {
    event.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch('/api/sessions', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ host, cookie }),
      });
      const body = (await response.json().catch(() => ({}))) as {
        host?: string;
        cookies?: string[];
        added?: number;
        detail?: string;
      };

      if (!response.ok) {
        setMessage({ text: body.detail ?? 'That could not be saved.', bad: true });
        return;
      }

      // The paste is cleared on success and only on success: a rejected header the
      // reader has to fetch again from devtools is the one thing worth keeping.
      setCookie('');
      setHost('');
      setMessage({
        text: `Stored ${String(body.added ?? 0)} cookies for ${body.host ?? host}.`,
        bad: false,
      });
      setReloads((n) => n + 1);
    } catch {
      setMessage({ text: 'Could not reach this deployment.', bad: true });
    } finally {
      setBusy(false);
    }
  }

  async function signOut(target: string) {
    if (!confirm(`Forget the session for ${target}? You would need to paste a new one.`)) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/sessions?host=${encodeURIComponent(target)}`, {
        method: 'DELETE',
      });
      if (!response.ok && response.status !== 404) {
        setMessage({ text: `Could not forget ${target}.`, bad: true });
        return;
      }
      setMessage({ text: `Forgot the session for ${target}.`, bad: false });
      setReloads((n) => n + 1);
    } catch {
      setMessage({ text: 'Could not reach this deployment.', bad: true });
    } finally {
      setBusy(false);
    }
  }

  if (loadError !== null) return <p className={styles.bad}>{loadError}</p>;
  if (listing === null) return <p className={styles.muted}>Checking…</p>;

  /*
   * No store attached is a normal state, not a failure.
   *
   * Extraction works without one — that is the entire first stage of this design — so
   * this says what is missing and what it would add, rather than reading as broken.
   */
  if (!listing.configured) {
    return (
      <>
        <p className={styles.muted}>
          No key-value store is attached to this deployment, so publisher sessions cannot be saved
          here.
        </p>
        {listing.detail !== undefined && <p className={styles.detail}>{listing.detail}</p>}
        <p className={styles.note}>
          Articles are still fetched from the publisher when Instapaper returns a stub — that works
          without any session and already handles a good share of soft paywalls. Attach a KV store
          and set <code>STASH_ENCRYPTION_KEY</code> to add the rest.
        </p>
      </>
    );
  }

  return (
    <>
      {listing.cleared.length > 0 && (
        <p className={styles.bad}>
          {listing.cleared.join(', ')}: the stored session could not be read and has been removed.
          This usually means <code>STASH_ENCRYPTION_KEY</code> changed. Paste it again.
        </p>
      )}

      {listing.hosts.length === 0 ? (
        <p className={styles.muted}>No publisher sessions stored.</p>
      ) : (
        <ul className={styles.list}>
          {listing.hosts.map((row) => (
            <li key={row.host} className={styles.row}>
              <div className={styles.rowText}>
                <p className={styles.host}>{row.host}</p>
                {/*
                  Names, never values — and truncated, because a consent platform can
                  contribute forty of them and the useful information is the first few
                  plus the count.
                */}
                <p className={styles.cookies}>
                  {row.cookies.length} cookies{savedAgo(row.updatedAt)}
                  {row.cookies.length > 0 && `: ${row.cookies.slice(0, 6).join(', ')}`}
                  {row.cookies.length > 6 && ', …'}
                </p>
              </div>
              <button
                type="button"
                className={styles.button}
                disabled={busy}
                onClick={() => void signOut(row.host)}
              >
                Sign out
              </button>
            </li>
          ))}
        </ul>
      )}

      <form className={styles.form} onSubmit={(event) => void add(event)}>
        <label className={styles.label} htmlFor="session-host">
          Publisher
        </label>
        <input
          id="session-host"
          className={styles.input}
          value={host}
          onChange={(event) => setHost(event.target.value)}
          placeholder="www.ft.com"
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          required
        />

        <label className={styles.label} htmlFor="session-cookie">
          Cookie header
        </label>
        <textarea
          id="session-cookie"
          className={styles.textarea}
          value={cookie}
          onChange={(event) => setCookie(event.target.value)}
          placeholder="FTSession=…; FTUser=…"
          rows={4}
          spellCheck={false}
          required
        />

        <button className={styles.primary} type="submit" disabled={busy}>
          {busy ? 'Saving…' : 'Save session'}
        </button>
      </form>

      {message !== null && <p className={message.bad ? styles.bad : styles.good}>{message.text}</p>}

      <p className={styles.note}>
        Sign in to the publisher in an ordinary browser tab, open an article, then press F12 →{' '}
        <strong>Network</strong> → click the first request → <strong>Request Headers</strong> → copy
        the value of <code>cookie</code>. Paste the whole line above. The full walkthrough, browser
        by browser, is in <code>SESSIONS.md</code>.
      </p>
      <p className={styles.note}>
        This is a desktop-only step — phone browsers have no usable developer tools — but you only
        do it <em>once per publisher</em>, not once per device. The session is stored with this
        deployment, encrypted, so every device you read on gets full articles from then on. Only the{' '}
        <code>name=value</code> pairs are kept, and the values are never sent back to a browser.
      </p>
    </>
  );
}
