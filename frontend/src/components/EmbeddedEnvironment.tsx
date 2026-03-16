import { useState } from 'react';
import Editor from '@monaco-editor/react';
import { submitEmbeddedAssessment } from '../api/embedded-assessments';
import type { EmbeddedAssessment, RubricResult } from '../api/embedded-assessments';

interface EmbeddedEnvironmentProps {
  assessment: EmbeddedAssessment;
  onClose: () => void;
  onSubmitSuccess: () => void;
}

export function EmbeddedEnvironment({
  assessment,
  onClose,
  onSubmitSuccess,
}: EmbeddedEnvironmentProps) {
  const [code, setCode] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<{
    passed: boolean;
    score: number;
    passedCriteria: number;
    totalCriteria: number;
    rubricResults: RubricResult[];
  } | null>(null);

  const handleSubmit = async () => {
    if (!code.trim()) {
      setError('Please write your code before submitting.');
      return;
    }

    if (!window.confirm(
      '⚠️ Are you sure you want to submit?\n\n' +
      'Make sure your code is complete and ready for grading.\n\n' +
      'You cannot change your submission after this point.'
    )) {
      return;
    }

    try {
      setIsSubmitting(true);
      setError(null);

      console.log('Submitting embedded assessment:', assessment.milestoneId);

      const result = await submitEmbeddedAssessment(assessment.milestoneId, code);

      console.log('Submission result:', result);

      setResults({
        passed: result.passed,
        score: result.score,
        passedCriteria: result.passedCriteria,
        totalCriteria: result.totalCriteria,
        rubricResults: result.rubricResults,
      });

      setIsSubmitted(true);
      onSubmitSuccess();

    } catch (err: any) {
      console.error('Submission failed:', err);
      setError('Failed to submit. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  // Results view
  if (isSubmitted && results) {
    return (
      <div style={{
        position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
        backgroundColor: '#f5f5f5', zIndex: 1000, overflow: 'auto'
      }}>
        <div style={{ maxWidth: '900px', margin: '0 auto', padding: '30px' }}>

          {/* Header */}
          <div style={{
            background: results.passed ? '#d4edda' : '#f8d7da',
            border: `2px solid ${results.passed ? '#28a745' : '#dc3545'}`,
            borderRadius: '12px', padding: '30px',
            textAlign: 'center', marginBottom: '30px'
          }}>
            <h1 style={{
              color: results.passed ? '#28a745' : '#dc3545',
              margin: '0 0 15px 0', fontSize: '36px'
            }}>
              {results.passed ? '🎉 Congratulations!' : '📚 Keep Learning!'}
            </h1>
            <p style={{ fontSize: '24px', color: '#333', margin: '0 0 10px 0' }}>
              Score: <strong>{results.score}%</strong> ({results.passedCriteria} / {results.totalCriteria} criteria)
            </p>
            {results.passed && (
              <p style={{ fontSize: '16px', color: '#155724', margin: 0 }}>
                Your submission is pending instructor review. Your credential will be issued after approval.
              </p>
            )}
          </div>

          {/* Rubric breakdown */}
          <div style={{
            background: '#fff', borderRadius: '12px', padding: '25px',
            marginBottom: '20px', boxShadow: '0 2px 8px rgba(0,0,0,0.1)'
          }}>
            <h2 style={{ color: '#333', marginTop: 0 }}>Rubric Breakdown</h2>

            {results.rubricResults.map((result, index) => (
              <div
                key={index}
                style={{
                  borderBottom: index < results.rubricResults.length - 1 ? '1px solid #dee2e6' : 'none',
                  padding: '18px 0'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '12px' }}>
                  <span style={{
                    background: result.passed ? '#28a745' : '#dc3545',
                    color: 'white', padding: '3px 10px',
                    borderRadius: '4px', fontSize: '12px',
                    whiteSpace: 'nowrap', flexShrink: 0
                  }}>
                    {result.passed ? '✓ Passed' : '✗ Failed'}
                  </span>
                  <div>
                    <p style={{ margin: '0 0 6px 0', color: '#333', fontWeight: 'bold', fontSize: '15px' }}>
                      {result.criterion}
                    </p>
                    <p style={{ margin: 0, color: '#666', fontSize: '14px' }}>
                      {result.feedback}
                    </p>
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Close button */}
          <div style={{ textAlign: 'center' }}>
            <button
              onClick={onClose}
              style={{
                padding: '15px 40px', background: '#007bff', color: 'white',
                border: 'none', borderRadius: '8px', cursor: 'pointer',
                fontSize: '18px', fontWeight: 'bold'
              }}
            >
              Back to Assessments
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Editor view
  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      backgroundColor: '#1e1e1e', zIndex: 1000,
      display: 'flex', flexDirection: 'column'
    }}>
      {/* Header */}
      <div style={{
        background: '#252526', padding: '12px 20px',
        borderBottom: '1px solid #3c3c3c',
        display: 'flex', justifyContent: 'space-between', alignItems: 'center'
      }}>
        <div>
          <h2 style={{ margin: 0, color: '#fff', fontSize: '18px' }}>{assessment.title}</h2>
          <p style={{ margin: '4px 0 0 0', color: '#999', fontSize: '13px' }}>
            {assessment.description}
          </p>
        </div>
        <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
          <button
            onClick={onClose}
            style={{
              padding: '8px 16px', background: 'transparent', color: '#999',
              border: '1px solid #555', borderRadius: '4px',
              cursor: 'pointer', fontSize: '13px'
            }}
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={isSubmitting || isSubmitted}
            style={{
              padding: '8px 20px',
              background: isSubmitting ? '#555' : '#28a745',
              color: 'white', border: 'none', borderRadius: '4px',
              cursor: isSubmitting ? 'not-allowed' : 'pointer',
              fontSize: '14px', fontWeight: 'bold'
            }}
          >
            {isSubmitting ? '⏳ Grading...' : '✅ Submit'}
          </button>
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div style={{
          background: '#5c1a1a', color: '#f8d7da',
          padding: '10px 20px', fontSize: '14px'
        }}>
          {error}
        </div>
      )}

      {/* Rubric panel + Editor split */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>

        {/* Left: Rubric */}
        <div style={{
          width: '320px', flexShrink: 0,
          background: '#252526', borderRight: '1px solid #3c3c3c',
          overflow: 'auto', padding: '20px'
        }}>
          <h3 style={{ color: '#ccc', marginTop: 0, fontSize: '14px', textTransform: 'uppercase', letterSpacing: '1px' }}>
            Grading Criteria
          </h3>
          <p style={{ color: '#888', fontSize: '12px', marginBottom: '16px' }}>
            Your code will be evaluated against each of the following criteria.
          </p>
          {assessment.rubric.map((criterion, index) => (
            <div
              key={index}
              style={{
                background: '#2d2d2d', borderRadius: '6px',
                padding: '12px', marginBottom: '8px',
                borderLeft: '3px solid #007bff'
              }}
            >
              <p style={{ margin: 0, color: '#ccc', fontSize: '13px', lineHeight: '1.5' }}>
                {index + 1}. {criterion}
              </p>
            </div>
          ))}
        </div>

        {/* Right: Monaco Editor */}
        <div style={{ flex: 1, overflow: 'hidden' }}>
          <Editor
            height="100%"
            language="c"
            value={code}
            onChange={(value) => setCode(value || '')}
            theme="vs-dark"
            options={{
              minimap: { enabled: false },
              fontSize: 14,
              lineNumbers: 'on',
              scrollBeyondLastLine: false,
              automaticLayout: true,
              tabSize: 4,
              wordWrap: 'on',
              padding: { top: 16 },
              readOnly: isSubmitted
            }}
          />
        </div>
      </div>
    </div>
  );
}