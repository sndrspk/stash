import { RouterProvider } from 'react-router-dom';

import { UpdatePrompt } from './components/UpdatePrompt';
import { usePaperTheme } from './hooks/usePaperTheme';
import { router } from './router';

/**
 * The router, plus the two things that have to sit above it.
 *
 * The reader's chosen paper is applied to `<html>`, so it has to be set by something
 * that renders on every screen — including the gate, which is outside the app layout.
 * The update prompt is here for the same reason and one more: it registers the
 * service worker, which must happen once for the whole app rather than once per
 * route.
 */
export function App() {
  usePaperTheme();
  return (
    <>
      <RouterProvider router={router} />
      <UpdatePrompt />
    </>
  );
}
