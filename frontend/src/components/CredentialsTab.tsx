import { useEffect, useState } from 'react';
import { getUserCredentials, type Credential } from '../api/credentials';
import { Alert, Badge, Button, Card, EmptyState, Spinner } from './ui';
import styles from './CredentialsTab.module.css';

export function CredentialsTab() {
  const [credentials, setCredentials] = useState<Credential[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  useEffect(() => {
    async function loadCredentials() {
      try {
        setLoading(true);
        setError(null);
        const response = await getUserCredentials();
        setCredentials(response.credentials || []);
      } catch (err: any) {
        console.error('Error loading credentials:', err);
        setError(err.message || 'Failed to load credentials');
      } finally {
        setLoading(false);
      }
    }

    loadCredentials();
  }, []);

  const handleCopyLink = (credential: Credential) => {
    navigator.clipboard.writeText(credential.bcdiplomaUrl);
    setCopiedId(credential.credentialId);
    setTimeout(() => {
      setCopiedId((current) => (current === credential.credentialId ? null : current));
    }, 2000);
  };

  if (loading) {
    return (
      <div className={styles.loading}>
        <Spinner decorative />
        <p className={styles.loadingText} role="status">
          Loading your credentials…
        </p>
      </div>
    );
  }

  if (error) {
    return (
      <Alert variant="danger" title="We couldn't load your credentials">
        {error}
      </Alert>
    );
  }

  if (credentials.length === 0) {
    return (
      <Card>
        <EmptyState
          headingLevel={2}
          title="No credentials yet"
          description="You earn a credential by passing a proctored assessment and the instructor's review. Once it is approved, it appears here."
        />
      </Card>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.grid}>
        {credentials.map((credential) => (
          <Card
            key={credential.credentialId}
            headingLevel={2}
            title={credential.problemTitle}
            actions={<Badge variant="success">Score: {credential.score}%</Badge>}
            footer={
              <div className={styles.actions}>
                <a
                  href={credential.bcdiplomaUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={styles.certificateLink}
                >
                  View certificate
                </a>
                <Button variant="secondary" aria-live="polite" onClick={() => handleCopyLink(credential)}>
                  {copiedId === credential.credentialId ? 'Copied!' : 'Copy certificate link'}
                </Button>
              </div>
            }
          >
            <dl className={styles.details}>
              <dt>Recipient</dt>
              <dd>{credential.recipientName}</dd>
              <dt>Issued</dt>
              <dd>{new Date(credential.issuedAt).toLocaleDateString()}</dd>
            </dl>
          </Card>
        ))}
      </div>

      <Card title="Summary" headingLevel={2}>
        <dl className={styles.summary}>
          <div>
            <dt>Total credentials</dt>
            <dd className={styles.statValue}>{credentials.length}</dd>
          </div>
          <div>
            <dt>Latest credential</dt>
            <dd className={styles.statValue}>
              {new Date(
                Math.max(...credentials.map(c => new Date(c.issuedAt).getTime()))
              ).toLocaleDateString()}
            </dd>
          </div>
        </dl>
      </Card>
    </div>
  );
}
