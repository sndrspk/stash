/**
 * How fast Stash is allowed to walk a list of URLs.
 *
 * A first sync on a real queue is two hundred bookmarks, and resolving them means
 * two hundred fetches of other people's pages. Two limits keep that from being
 * indistinguishable from a small scrape:
 *
 * - **At most a few in flight at once**, so the deployment does not open two hundred
 *   sockets and so the whole pass degrades gracefully on a slow connection.
 * - **A pause between requests to the same host**, which is the one that actually
 *   matters. Concurrency alone is no protection: a reader who saves twenty articles
 *   from one newspaper would send all twenty to that newspaper as fast as three
 *   slots allow.
 *
 * The scheduler is therefore host-aware rather than a plain pool. When the next item
 * belongs to a host that was just called, it looks past it for one that is ready
 * instead of holding a slot idle — so twenty articles from one publisher are spread
 * out without stalling the nineteen other publishers behind them.
 *
 * The clock is injectable, which is what makes the delay testable in milliseconds
 * rather than in real seconds.
 */

/** Conservative on purpose: the plan says start at 3–4 and this is unattended work. */
export const DEFAULT_CONCURRENCY = 3;
/** One second between requests to a host — slower than a person browsing it. */
export const DEFAULT_PER_HOST_DELAY_MS = 1000;

export interface BoundedRunOptions {
  concurrency?: number;
  perHostDelayMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * The throttling key.
 *
 * The hostname, not the origin: `http` and `https` on one host are one server, and
 * an unparseable URL gets its own bucket rather than sharing the empty-string
 * bucket with every other malformed entry.
 */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return `invalid:${url}`;
  }
}

/**
 * Runs `worker` over `items`, bounded and host-throttled.
 *
 * A worker that throws does not strand the rest of the pass — its failure is its own
 * to record, and one bad URL out of two hundred must not stop the other
 * hundred-and-ninety-nine. Aborting stops the workers picking up new items; it does
 * not cancel one already running, which the worker's own `signal` handling is for.
 */
export async function runBounded(
  items: readonly string[],
  worker: (url: string) => Promise<void>,
  options: BoundedRunOptions = {},
): Promise<void> {
  const {
    concurrency = DEFAULT_CONCURRENCY,
    perHostDelayMs = DEFAULT_PER_HOST_DELAY_MS,
    now = Date.now,
    sleep = wait,
    signal,
  } = options;

  const queue = [...items];
  /** Host → the earliest time the next request to it may start. */
  const nextAllowed = new Map<string, number>();

  async function pump(): Promise<void> {
    for (;;) {
      if (signal?.aborted === true) return;
      if (queue.length === 0) return;

      const at = now();
      let index = -1;
      let earliest = Number.POSITIVE_INFINITY;

      for (const [i, url] of queue.entries()) {
        const ready = nextAllowed.get(hostOf(url)) ?? 0;
        if (ready <= at) {
          index = i;
          break;
        }
        if (ready < earliest) earliest = ready;
      }

      if (index === -1) {
        // Everything left is cooling down. Wait for the soonest, then look again —
        // another worker may have taken it by then, which the re-scan handles.
        await sleep(Math.max(1, earliest - at));
        continue;
      }

      const [url] = queue.splice(index, 1);
      if (url === undefined) continue;
      nextAllowed.set(hostOf(url), at + perHostDelayMs);

      try {
        await worker(url);
      } catch {
        // Deliberately swallowed; see the note above.
      }
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, () => pump()));
}
