import { PageHeader } from '../components/ui';
import { CredentialsTab } from '../components/CredentialsTab';

export function CredentialsPage() {
  return (
    <>
      <PageHeader title="Credentials" subtitle="Credentials you have earned." />
      <CredentialsTab />
    </>
  );
}
