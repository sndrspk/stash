import { useState } from 'react';

import { useCacheUsage, useClearCache } from '../lib/queries';
import styles from './CacheSettings.module.css';

/**
 * What the cache is holding, and a way to empty it.
 *
 * The interesting decision is what "clear" leaves behind, and it is made in
 * `store.ts` rather than here: pending actions, preferences and bookmark rows all
 * survive. Someone freeing space is not asking to un-archive articles or reset their
 * typeface. This screen's job is to say so plainly *before* the button is pressed,
 * because a destructive action whose scope you learn afterwards is one people stop
 * trusting.
 */

/** Bytes as a person would say them. Two significant figures is plenty here. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${String(bytes)} B`;
  const units = ['kB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value < 10 ? value.toFixed(1) : String(Math.round(value))} ${units[unit] ?? 'kB'}`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${String(n)} ${n === 1 ? one : many}`;

export function CacheSettings() {
  const { data: usage, isLoading } = useCacheUsage();
  const clear = useClearCache();
  const [message, setMessage] = useState<string | null>(null);

  function run() {
    if (
      !confirm(
        'Clear the cached article text and images? Your queue, your preferences and anything waiting to be sent are untouched. Articles will be downloaded again when you open them.',
      )
    ) {
      return;
    }
    setMessage(null);
    clear
      .mutateAsync()
      .then((result) => {
        setMessage(
          `Cleared ${plural(result.texts, 'article')} and ${plural(result.images, 'image')}.`,
        );
      })
      .catch((cause: unknown) => {
        setMessage(`Could not clear: ${cause instanceof Error ? cause.message : 'unknown error'}`);
      });
  }

  if (isLoading || usage === undefined) return <p className={styles.muted}>Checking…</p>;

  return (
    <>
      <p className={styles.figures}>
        {plural(usage.texts, 'cached article')}, {plural(usage.images, 'resolved image')},{' '}
        {plural(usage.bookmarks, 'bookmark')}.
      </p>

      {usage.pending > 0 && (
        <p className={styles.figures}>
          {plural(usage.pending, 'action')} waiting to reach Instapaper. Clearing the cache does not
          touch {usage.pending === 1 ? 'it' : 'them'}.
        </p>
      )}

      {/*
        The byte figure is origin-wide, and saying so matters: it includes the service
        worker's precache and the article images it holds, which clearing this will
        not remove. Presenting it as "the cache" would make the button look broken.
      */}
      <p className={styles.muted}>
        {usage.bytes === null
          ? 'This browser will not say how much space it is using.'
          : `${formatBytes(usage.bytes)} of browser storage in total, including the app itself and its images.`}
      </p>

      <button className={styles.button} type="button" disabled={clear.isPending} onClick={run}>
        {clear.isPending ? 'Clearing…' : 'Clear cached articles'}
      </button>

      {message !== null && <p className={styles.result}>{message}</p>}

      <p className={styles.note}>
        Removes the article text and the resolved image addresses, both of which are re-fetchable.
        Your unread queue, your reading preferences and anything waiting to be sent to Instapaper
        are left alone. Cached text is already purged by itself seven days after an article is
        archived or deleted, so this is for reclaiming space now rather than housekeeping.
      </p>
    </>
  );
}
