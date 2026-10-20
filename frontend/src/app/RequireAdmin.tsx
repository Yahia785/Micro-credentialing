import type { ReactNode } from 'react';
import { Navigate } from 'react-router';
import { useUser } from '../context/UserContext';

/** Redirects non-admins to `/`. The profile is always loaded by the time routes render. */
export function RequireAdmin({ children }: { children: ReactNode }) {
  const { isAdmin } = useUser();
  return isAdmin ? <>{children}</> : <Navigate to="/" replace />;
}
