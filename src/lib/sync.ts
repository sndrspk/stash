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

/** Entry types a `bookmarks/list` response mixes in that are not bookmarks. */
const NOT_BOOKMARKS = new Set(['user', 'folder', 'error', 'highlight', 'meta']);

/**
 * One bookmark, or null if the entry is not one.
 *
 * An entry counts as a bookmark when it has a usable `bookmark_id` and does not
 * declare itself as something else. Requiring `type === 'bookmark'` outright was
 * too strict: it holds for the array form, where entries are tagged because they
 * share one list, but not for the object form, where the bookmarks already sit
 * under their own key and carry no type at all.
 *
 * An entry without a usable id is skipped rather than coerced — a row keyed on 0
 * or NaN would collide with every other malformed row.
 */
function toBookmark(item: unknown): RemoteBookmark | null {
  if (typeof item !== 'object' || item === null) return null;
  const record = item as Record<string, unknown>;

  if (typeof record.type === 'string' && NOT_BOOKMARKS.has(record.type)) return null;

  const id = record.bookmark_id;
  // Instapaper sends this as a number, but a string id is cheap to accept and
  // expensive to have rejected silently.
  const bookmarkId = typeof id === 'number' ? id : typeof id === 'string' ? Number(id) : NaN;
  if (!Number.isFinite(bookmarkId) || bookmarkId <= 0) return null;

  return {
    bookmark_id: bookmarkId,
    title: str(record.title),
    url: str(record.url),
    time: num(record.time),
    description: str(record.description),
    hash: str(record.hash),
  };
}

/**
 * Extracts bookmarks from a `bookmarks/list` response, in either shape it comes in.
 *
 * **This assumed an array and shipped that way**, which meant every real call
 * parsed zero bookmarks — the account's unread folder looked empty, both here and
 * through `api/bookmarks`. Instapaper answered with an **object**, and an earlier
 * version returned `[]` for anything that was not an array, silently.
 *
 * Unit tests did not catch it because they asserted the array form, and the Phase 3
 * browser run did not catch it because the stub it ran against was written to the
 * same assumption. Both agreed with each other and neither had met the API.
 *
 * So this accepts both, and finds the bookmarks rather than being told where they
 * are: an array is scanned directly; an object is searched for an array-valued
 * property, preferring one named `bookmarks` but falling back to any array whose
 * entries look like bookmarks. That way a key rename upstream degrades into working
 * rather than into an empty queue.
 */
export function parseBookmarkList(raw: unknown): RemoteBookmark[] {
  const entries = findEntries(raw);

  const out: RemoteBookmark[] = [];
  for (const item of entries) {
    const bookmark = toBookmark(item);
    if (bookmark) out.push(bookmark);
  }
  return out;
}

/** The array most likely to hold bookmarks, from either response shape. */
function findEntries(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw !== 'object' || raw === null) return [];

  const record = raw as Record<string, unknown>;

  if (Array.isArray(record.bookmarks)) return record.bookmarks;

  // No `bookmarks` key: take the first array whose entries parse as bookmarks,
  // rather than the first array of any kind — `highlights` and `delete_ids` are
  // also arrays and would otherwise win by position.
  for (const value of Object.values(record)) {
    if (Array.isArray(value) && value.some((item) => toBookmark(item) !== null)) return value;
  }

  return [];
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
