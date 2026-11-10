import { PageHeader } from '../components/ui';
import { AdminReviewsTab } from '../components/AdminReviewsTab';
import styles from './AdminReviewsPage.module.css';

export function AdminReviewsPage() {
  return (
    <div className={styles.page}>
      <PageHeader title="Reviews" subtitle="Review proctored submissions and issue credentials." />
      <AdminReviewsTab />
    </div>
  );
}
