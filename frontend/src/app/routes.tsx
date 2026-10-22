import { createBrowserRouter, Navigate } from 'react-router';
import type { RouteObject } from 'react-router';
import { AppLayout } from './AppLayout';
import { RequireAdmin } from './RequireAdmin';
import { AdminReviewsPage } from '../pages/AdminReviewsPage';
import { AssessmentsPage } from '../pages/AssessmentsPage';
import { CredentialsPage } from '../pages/CredentialsPage';
import { NotFoundPage } from '../pages/NotFoundPage';
import { ProfilePage } from '../pages/ProfilePage';

/** Route metadata read by AppLayout to set the document title. */
export interface RouteHandle {
  title: string;
}

const devRoutes: RouteObject[] = import.meta.env.DEV
  ? [
      {
        path: 'dev/ui',
        handle: { title: 'UI components' } satisfies RouteHandle,
        // Lazy so the showcase is left out of production builds entirely.
        lazy: async () => ({ Component: (await import('../pages/dev/UiShowcase')).default }),
      },
    ]
  : [];

export const router = createBrowserRouter([
  {
    path: '/',
    element: <AppLayout />,
    children: [
      // Phase 2 replaces this redirect with a dashboard.
      { index: true, element: <Navigate to="/assessments" replace /> },
      {
        path: 'assessments',
        element: <AssessmentsPage />,
        handle: { title: 'Assessments' } satisfies RouteHandle,
      },
      // The old per-kind pages now live on the single Assessments page.
      { path: 'assessments/coding', element: <Navigate to="/assessments" replace /> },
      { path: 'assessments/embedded', element: <Navigate to="/assessments" replace /> },
      {
        path: 'credentials',
        element: <CredentialsPage />,
        handle: { title: 'Credentials' } satisfies RouteHandle,
      },
      {
        path: 'profile',
        element: <ProfilePage />,
        handle: { title: 'Profile' } satisfies RouteHandle,
      },
      {
        path: 'admin/reviews',
        element: (
          <RequireAdmin>
            <AdminReviewsPage />
          </RequireAdmin>
        ),
        handle: { title: 'Reviews' } satisfies RouteHandle,
      },
      ...devRoutes,
      {
        path: '*',
        element: <NotFoundPage />,
        handle: { title: 'Page not found' } satisfies RouteHandle,
      },
    ],
  },
]);
