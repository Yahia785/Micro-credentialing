import { Link } from 'react-router';
import { EmptyState } from '../components/ui';

export function NotFoundPage() {
  return (
    <EmptyState
      headingLevel={1}
      title="Page not found"
      description="The page you are looking for doesn't exist or has moved."
      action={<Link to="/">Go to the home page</Link>}
    />
  );
}
