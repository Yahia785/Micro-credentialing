import { PageHeader } from '../components/ui';
import { ProblemsTab } from '../components/ProblemsTab';

export function CodingProblemsPage() {
  return (
    <>
      <PageHeader title="Coding Problems" subtitle="Solve programming problems in a proctored editor." />
      <ProblemsTab />
    </>
  );
}
