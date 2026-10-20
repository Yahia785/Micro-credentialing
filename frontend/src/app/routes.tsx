import { createBrowserRouter, Navigate } from 'react-router';
import type { RouteObject } from 'react-router';
import { AppLayout } from './AppLayout';
import { RequireAdmin } from './RequireAdmin';
import { AdminReviewsPage } from '../pages/AdminReviewsPage';
import { CodingProblemsPage } from '../pages/CodingProblemsPage';
import { CredentialsPage } from '../pages/CredentialsPage';
import { EmbeddedAssessmentsPage } from '../pages/EmbeddedAssessmentsPage';
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
      { index: true, element: <Navigate to="/assessments/coding" replace /> },
      {
        path: 'assessments/coding',
        element: <CodingProblemsPage />,
        handle: { title: 'Coding Problems' } satisfies RouteHandle,
      },
      {
        path: 'assessments/embedded',
        element: <EmbeddedAssessmentsPage />,
        handle: { title: 'Embedded Systems' } satisfies RouteHandle,
      },
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
