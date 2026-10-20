import { PageHeader } from '../components/ui';
import { AdminReviewsTab } from '../components/AdminReviewsTab';

export function AdminReviewsPage() {
  return (
    <>
      <PageHeader title="Reviews" subtitle="Review proctored submissions and issue credentials." />
      <AdminReviewsTab />
    </>
  );
}
