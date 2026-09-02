import { useSyncExternalStore } from 'react';

/**
 * Whether the browser thinks it has a network.
 *
 * `useSyncExternalStore` rather than `useState` plus two `addEventListener`s, because
 * this is exactly what it is for: the value lives outside React, and subscribing by
 * hand gets the tearing case wrong — a component that mounts between the `offline`
 * event and its own effect running reads the stale initial value and never hears the
 * event that would have corrected it.
 *
 * **`navigator.onLine` is not a connectivity check.** It answers "is there a network
 * interface", so a captive portal, a dead router and a VPN that is up but routing
 * nowhere all read as online. That is fine for what it is used for here — choosing
 * between two sentences about a queue that will be replayed either way — and would
 * not be fine as a gate on whether to try. Nothing in Stash uses it to decide whether
 * to make a request; the request is made and its failure is the real answer.
 */

const subscribe = (onChange: () => void): (() => void) => {
  window.addEventListener('online', onChange);
  window.addEventListener('offline', onChange);
  return () => {
    window.removeEventListener('online', onChange);
    window.removeEventListener('offline', onChange);
  };
};

const getSnapshot = (): boolean => navigator.onLine;

/** Server-side and during prerender there is no navigator; assume online. */
const getServerSnapshot = (): boolean => true;

export function useOnline(): boolean {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
