import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import { listImportedSubmissions, startImportedPractice } from '../../api/interviews';
import type { ImportedRecord } from '../../types/interview';
import { importedPracticePath } from '../../utils/interview';
import { Alert, Badge, Button, Spinner } from '../ui';
import styles from './ImportedPracticePanel.module.css';

interface ImportedPracticePanelProps {
  /** The interview-only assessment the practice interview belongs to. */
  milestoneId: string;
}

const STATUS_TEXT: Record<string, string> = {
  ok: 'Compiles',
  file_does_not_compile: 'File does not compile',
  nothing_compiles: 'Nothing compiles',
  missing_files: 'Missing files',
  no_version_before_deadline: 'No version before the deadline',
};

const errorText = (error: unknown) => (error instanceof Error && error.message ? error.message : 'Something went wrong. Please try again.');

/**
 * Admin only: the imported students an interview-only assessment can be practised on. "Practice as this student" starts a practice
 * interview on that student's code and plan and opens it. The list shows the GitHub username, so it is for instructors only.
 */
export function ImportedPracticePanel({ milestoneId }: ImportedPracticePanelProps) {
  const navigate = useNavigate();
  const [records, setRecords] = useState<ImportedRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [startingId, setStartingId] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setRecords(await listImportedSubmissions());
    } catch (failure) {
      setError(errorText(failure));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const start = async (record: ImportedRecord) => {
    setStartingId(record.importId);
    setStartError(null);
    try {
      const started = await startImportedPractice(record.importId, milestoneId);
      navigate(importedPracticePath(started.interviewId));
    } catch (failure) {
      setStartError(errorText(failure));
      setStartingId(null);
    }
  };

  return (
    <section className={styles.panel} aria-label="Practice as an imported student">
      <h4 className={styles.title}>Practice as an imported student</h4>
      {error && (
        <Alert variant="danger">
          <p className={styles.alertText}>{error}</p>
          <Button size="sm" variant="secondary" onClick={() => void load()}>
            Try again
          </Button>
        </Alert>
      )}
      {!error && records === null && (
        <p className={styles.status} role="status">
          <Spinner size="sm" decorative /> Loading the imported students…
        </p>
      )}
      {startError && <Alert variant="danger">{startError}</Alert>}
      {records !== null && records.length === 0 && <p className={styles.status}>No imported submissions yet.</p>}
      {records !== null && records.length > 0 && (
        <div className={styles.scroller}>
          <table className={styles.table}>
            <caption className={styles.caption}>Imported students, by GitHub username</caption>
            <thead>
              <tr>
                <th scope="col">Username</th>
                <th scope="col">Status</th>
                <th scope="col">Form</th>
                <th scope="col">
                  <span className={styles.visuallyHidden}>Action</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {records.map((record) => (
                <tr key={record.importId}>
                  <td>{record.githubUsername}</td>
                  <td>{STATUS_TEXT[record.status] ?? record.status}</td>
                  <td>{record.form ?? '–'}</td>
                  <td className={styles.action}>
                    {record.hasPlan ? (
                      <Button
                        size="sm"
                        variant="secondary"
                        loading={startingId === record.importId}
                        disabled={startingId !== null}
                        onClick={() => void start(record)}
                        aria-label={`Practice as ${record.githubUsername}`}
                      >
                        {startingId === record.importId ? 'Starting…' : 'Practice as this student'}
                      </Button>
                    ) : (
                      <Badge variant="neutral">No interview plan</Badge>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
