import { RouterProvider } from 'react-router-dom';

import { usePaperTheme } from './hooks/usePaperTheme';
import { router } from './router';

/**
 * The router, plus the one thing that has to sit above it.
 *
 * The reader's chosen paper is applied to `<html>`, so it has to be set by something
 * that renders on every screen — including the gate, which is outside the app
 * layout. This component exists for that and nothing else.
 */
export function App() {
  usePaperTheme();
  return <RouterProvider router={router} />;
}
