import { createBrowserRouter } from 'react-router-dom';

import { AppLayout } from './AppLayout';
import { FrontPage } from './routes/FrontPage';
import { NotFound } from './routes/NotFound';
import { Reader } from './routes/Reader';
import { Settings } from './routes/Settings';
import { Unlock } from './routes/Unlock';

/*
 * The four routes from the work plan, plus a catch-all.
 *
 * /unlock sits outside AppLayout deliberately: it is the one screen reachable
 * without a session, so it must not render chrome that assumes one.
 */
export const router = createBrowserRouter([
  { path: '/unlock', element: <Unlock /> },
  {
    element: <AppLayout />,
    children: [
      { path: '/', element: <FrontPage /> },
      { path: '/read/:bookmarkId', element: <Reader /> },
      { path: '/settings', element: <Settings /> },
      { path: '*', element: <NotFound /> },
    ],
  },
]);
