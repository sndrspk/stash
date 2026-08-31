/**
 * Reconciling a remote bookmark list against what is cached locally.
 *
 * Kept pure and separate from IndexedDB, because the decisions here are the part
 * worth testing: which rows to write, and — more delicately — what to do about a
 * local row the remote list no longer mentions.
 */
import type { BookmarkRecord } from './db.js';

/** A bookmark as Instapaper's `bookmarks/list` returns it. */
export interface RemoteBookmark {
  bookmark_id: number;
  title: string;
  url: string;
  time: number;
  description: string;
  hash: string;
}

export interface Reconciliation {
  /** Rows to put, whether new or updated. */
  upserts: BookmarkRecord[];
  /** Ids present locally as unread, absent remotely, to be marked `gone`. */
  gone: number[];
}

const str = (value: unknown): string => (typeof value === 'string' ? value : '');
const num = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : 0;

/**
 * Extracts bookmarks from a `bookmarks/list` response.
 *
 * The response is a heterogeneous array — user records, folder records and an
 * optional error all share it — so entries are selected by `type` rather than by
 * position. Anything without a usable `bookmark_id` is skipped rather than coerced:
 * a row keyed on 0 or NaN would collide with every other malformed row.
 */
export function parseBookmarkList(raw: unknown): RemoteBookmark[] {
  if (!Array.isArray(raw)) return [];

  const out: RemoteBookmark[] = [];
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const record = item as Record<string, unknown>;
    if (record.type !== 'bookmark') continue;

    const id = record.bookmark_id;
    // Instapaper sends this as a number, but a string id is cheap to accept and
    // expensive to have rejected silently.
    const bookmarkId = typeof id === 'number' ? id : typeof id === 'string' ? Number(id) : NaN;
    if (!Number.isFinite(bookmarkId) || bookmarkId <= 0) continue;

    out.push({
      bookmark_id: bookmarkId,
      title: str(record.title),
      url: str(record.url),
      time: num(record.time),
      description: str(record.description),
      hash: str(record.hash),
    });
  }
  return out;
}

/**
 * Works out what to write after a sync of the unread folder.
 *
 * Rules, and the reasoning behind the one that matters:
 *
 * - A remote bookmark becomes or stays `unread`, and its `purge_after` is cleared.
 *   Its presence is proof it belongs in the queue, which also handles the undo case:
 *   archive something, change your mind, and the next sync un-marks its cached text
 *   before the grace period expires.
 * - A local **unread** row the remote list omits is marked `gone`, never deleted.
 * - A local **archived** or **deleted** row the remote list omits is left alone. Its
 *   absence is the expected consequence of our own action, not news.
 *
 * `gone` exists because dropping rows on absence makes the cache only as trustworthy
 * as the last response. A truncated page, a folder move, or a transient empty list
 * would each destroy local state that took API calls to build. Marking is reversible:
 * the row survives, the front page stops showing it, and the next sync that mentions
 * it restores it to unread.
 *
 * That includes the alarming case — a response with no bookmarks at all marks
 * everything gone. It is still the right behaviour: zero unread is a real state that
 * the front page has to render anyway, nothing is destroyed, and a later sync
 * restores every row. There is no information in the response that would let us tell
 * a genuine empty queue from a bad one, so guessing would only make the failure
 * quieter, not rarer.
 */
export function reconcile(
  local: readonly BookmarkRecord[],
  remote: readonly RemoteBookmark[],
  now: number,
): Reconciliation {
  const seen = new Set<number>();

  const upserts = remote.map((incoming) => {
    seen.add(incoming.bookmark_id);
    // Nothing is carried over from an existing row. Every field here is
    // authoritative from Instapaper, and purge_after must clear on reappearance —
    // which is exactly what makes an undone archive restore its cached text.
    return {
      ...incoming,
      folder: 'unread',
      state: 'unread' as const,
      synced_at: now,
      purge_after: null,
    } satisfies BookmarkRecord;
  });

  const gone = local
    .filter((row) => row.state === 'unread' && !seen.has(row.bookmark_id))
    .map((row) => row.bookmark_id);

  return { upserts, gone };
}
