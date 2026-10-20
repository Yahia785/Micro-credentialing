import { PageHeader } from '../components/ui';
import { EmbeddedAssessmentsTab } from '../components/EmbeddedAssessmentsTab';

export function EmbeddedAssessmentsPage() {
  return (
    <>
      <PageHeader title="Embedded Systems" subtitle="Complete embedded systems assessments reviewed by an instructor." />
      <EmbeddedAssessmentsTab />
    </>
  );
}
