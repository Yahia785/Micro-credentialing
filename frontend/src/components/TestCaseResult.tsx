interface TestResult {
  testCaseId?: string;
  passed: boolean;
  input: string;
  output: string;
  expectedOutput: string;
  executionTime?: number;
  memory?: number;
  error?: string;
  isHidden?: boolean;
}

interface TestCaseResultProps {
  result: TestResult;
  index: number;
}

export function TestCaseResult({ result, index }: TestCaseResultProps) {
  const statusColor = result.passed ? '#28a745' : '#dc3545';
  const statusIcon = result.passed ? '✓' : '✗';
  
  return (
    <div style={{
      border: `2px solid ${statusColor}`,
      borderRadius: '8px',
      padding: '15px',
      marginBottom: '10px',
      backgroundColor: result.passed ? '#d4edda' : '#f8d7da'
    }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '10px'
      }}>
        <h4 style={{
          margin: 0,
          color: '#333',
          display: 'flex',
          alignItems: 'center',
          gap: '8px'
        }}>
          <span style={{
            background: statusColor,
            color: 'white',
            width: '24px',
            height: '24px',
            borderRadius: '50%',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '14px',
            fontWeight: 'bold'
          }}>
            {statusIcon}
          </span>
          Test Case {index + 1}
          {result.isHidden && (
            <span style={{
              fontSize: '12px',
              color: '#666',
              fontWeight: 'normal',
              fontStyle: 'italic'
            }}>
              (Hidden)
            </span>
          )}
        </h4>
        
        {result.executionTime !== undefined && (
          <span style={{
            fontSize: '12px',
            color: '#666',
            fontWeight: 'normal'
          }}>
            ⏱️ {result.executionTime}ms
            {result.memory !== undefined && ` | 💾 ${(result.memory / 1024).toFixed(2)}MB`}
          </span>
        )}
      </div>

      {!result.isHidden && (
        <>
          <div style={{ marginBottom: '10px' }}>
            <strong style={{ color: '#333', display: 'block', marginBottom: '5px' }}>
              Input:
            </strong>
            <pre style={{
              background: '#f5f5f5',
              padding: '10px',
              borderRadius: '4px',
              margin: 0,
              overflow: 'auto',
              maxHeight: '100px',
              fontSize: '13px',
              color: '#333'
            }}>
              {result.input || '(empty)'}
            </pre>
          </div>

          <div style={{ marginBottom: '10px' }}>
            <strong style={{ color: '#333', display: 'block', marginBottom: '5px' }}>
              Your Output:
            </strong>
            <pre style={{
              background: '#f5f5f5',
              padding: '10px',
              borderRadius: '4px',
              margin: 0,
              overflow: 'auto',
              maxHeight: '100px',
              fontSize: '13px',
              color: '#333'
            }}>
              {result.output || '(no output)'}
            </pre>
          </div>

          <div style={{ marginBottom: '10px' }}>
            <strong style={{ color: '#333', display: 'block', marginBottom: '5px' }}>
              Expected Output:
            </strong>
            <pre style={{
              background: '#f5f5f5',
              padding: '10px',
              borderRadius: '4px',
              margin: 0,
              overflow: 'auto',
              maxHeight: '100px',
              fontSize: '13px',
              color: '#333'
            }}>
              {result.expectedOutput}
            </pre>
          </div>
        </>
      )}

      {result.error && (
        <div style={{ marginTop: '10px' }}>
          <strong style={{ color: '#dc3545', display: 'block', marginBottom: '5px' }}>
            Error:
          </strong>
          <pre style={{
            background: '#f8d7da',
            padding: '10px',
            borderRadius: '4px',
            margin: 0,
            overflow: 'auto',
            maxHeight: '100px',
            fontSize: '13px',
            color: '#721c24',
            border: '1px solid #f5c6cb'
          }}>
            {result.error}
          </pre>
        </div>
      )}

      {result.isHidden && (
        <p style={{
          color: '#666',
          fontSize: '14px',
          fontStyle: 'italic',
          margin: '10px 0 0 0'
        }}>
          Test case details are hidden for final submission.
        </p>
      )}
    </div>
  );
}