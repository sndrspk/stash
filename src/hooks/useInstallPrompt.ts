import { useCallback, useEffect, useState } from 'react';

/**
 * `beforeinstallprompt` is not in lib.dom — it is a Chromium extension to the spec.
 */
interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

/**
 * Captures the browser's install prompt so it can be offered at a moment of our
 * choosing rather than never.
 *
 * `available` is false on iOS in every case: Safari has no `beforeinstallprompt`
 * and installing is a manual Share → Add to Home Screen. That is why the caller
 * hides itself rather than rendering a button that cannot work — and why the iOS
 * install path is a Phase 8 documentation problem, not a code one.
 */
export function useInstallPrompt() {
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    const onBeforeInstall = (event: Event) => {
      // Chromium shows its own mini-infobar unless the event is cancelled.
      event.preventDefault();
      setDeferred(event as BeforeInstallPromptEvent);
    };
    // Once installed the captured event is stale — drop it so the button goes away.
    const onInstalled = () => setDeferred(null);

    window.addEventListener('beforeinstallprompt', onBeforeInstall);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onBeforeInstall);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const promptInstall = useCallback(async () => {
    if (!deferred) return;
    await deferred.prompt();
    await deferred.userChoice;
    // The event is single-use whatever the reader chose.
    setDeferred(null);
  }, [deferred]);

  return { available: deferred !== null, promptInstall };
}
