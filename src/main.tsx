import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import './styles/fonts.css';
import './styles/theme.css';
import { App } from './App';
import { requestPersistence } from './lib/db';
import { runStartupPurge } from './lib/queries';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Reads come from IndexedDB, which only this app writes, so refetching on
      // focus buys nothing and costs a round trip on every tab switch.
      refetchOnWindowFocus: false,
      retry: 1,
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
