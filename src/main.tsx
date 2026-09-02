import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import './styles/fonts.css';
import './styles/theme.css';
import { App } from './App';
import { requestPersistence } from './lib/db';
import { runPendingFlush, runStartupPurge } from './lib/queries';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Reads come from IndexedDB, which only this app writes, so refetching on
      // focus buys nothing and costs a round trip on every tab switch.
      refetchOnWindowFocus: false,
      retry: 1,
      /*
       * Every query here reads IndexedDB, so pausing them when the browser reports
       * no network would be pausing a local database read. `always` is not a
       * workaround: it is the accurate description of what these queries depend on.
       */
      networkMode: 'always',
    },
    mutations: {
      /*
       * The same, and this one is load-bearing rather than tidy.
       *
       * TanStack Query's default `networkMode: 'online'` **pauses** a mutation while
       * the browser reports offline: `mutationFn` is never called, the mutation sits
       * `isPending` forever, and nothing resolves. That is the right default for a
       * mutation that is an HTTP request — and exactly wrong for these, which write
       * to IndexedDB first and queue the network part deliberately.
       *
       * The symptom was archiving on a train doing nothing at all: the button stayed
       * disabled, the article stayed in the queue, and no error appeared anywhere,
       * because the promise never settled. The whole Phase 8 queue sat behind a pause
       * that stopped it from ever being written to.
       */
      networkMode: 'always',
    },
  },
});

const root = document.getElementById('root');
if (!root) throw new Error('index.html is missing #root');

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </StrictMode>,
);

/*
 * Startup housekeeping, deliberately after render and deliberately not awaited.
 * Neither of these should hold the first paint: the purge only collects rows past a
 * seven-day grace period, and persistence is a request the browser may simply
 * refuse. Failures are logged rather than surfaced — there is nothing a reader could
 * do about either, and the cache is designed to survive being wiped.
 */
void runStartupPurge(queryClient).catch((error: unknown) => {
  console.warn('Purge sweep failed; cached rows will be collected next start.', error);
});

void requestPersistence().catch(() => {
  /* Best-effort by design; see requestPersistence. */
});

/*
 * Drain the offline queue: once now, and again whenever the network comes back.
 *
 * The listener is deliberately never removed. It is bound to the page rather than to
 * a component, because an archive queued in the reading view has to be sent whether
 * or not the reader is still on that screen — and because `online` is exactly the
 * moment worth acting on and it does not wait for a render.
 *
 * `flushOnce` inside makes the two triggers safe together: a phone rejoining a
 * network fires `online` while the app is still starting, and both would otherwise
 * read the same rows and send the same archive twice.
 */
const flush = () => {
  void runPendingFlush(queryClient).catch((error: unknown) => {
    // Nothing is lost by a failed pass — the intents are on disk and the next trigger
    // will try again. Logged rather than surfaced for exactly that reason.
    console.warn('Could not send queued actions; they are still queued.', error);
  });
};

flush();
window.addEventListener('online', flush);
