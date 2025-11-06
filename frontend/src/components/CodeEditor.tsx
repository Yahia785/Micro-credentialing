import { useState, useEffect } from 'react';
import Editor from '@monaco-editor/react';
import { submitCode } from '../api/submissions';
import { getTestCases } from '../api/testcases';
import { TestCaseResult } from './TestCaseResult';

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

interface TestCase {
  testCaseId: string;
  milestoneId: string;
  input: string;
  expectedOutput: string;
  isHidden: boolean;
  order?: number;
}

interface Milestone {
  milestoneId: string;
  title: string;
  description: string;
  concept?: string;
  difficulty: string;
  language?: string;
  starterCode?: string;
  timeLimit?: number;
  memoryLimit?: number;
}

interface CodeEditorProps {
  milestone: Milestone;
  onClose: () => void;
  onSubmitSuccess?: () => void;
}

export function CodeEditor({ milestone, onClose, onSubmitSuccess }: CodeEditorProps) {
  // Default language and starter code if not provided
  const defaultLanguage = milestone.language || 'python';
  const defaultStarterCode = milestone.starterCode || getDefaultStarterCode(defaultLanguage);

  const [code, setCode] = useState(defaultStarterCode);
  const [output, setOutput] = useState('');
  const [testResults, setTestResults] = useState<TestResult[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [activeTab, setActiveTab] = useState<'description' | 'output'>('description');
  const [submissionStatus, setSubmissionStatus] = useState<'idle' | 'success' | 'failed'>('idle');
  const [copiedToClipboard, setCopiedToClipboard] = useState(false);
  
  // Test cases state
  const [sampleTestCases, setSampleTestCases] = useState<TestCase[]>([]);
  const [loadingTestCases, setLoadingTestCases] = useState(true);
  const [testCasesError, setTestCasesError] = useState<string | null>(null);

  // Reset code when milestone changes
  useEffect(() => {
    setCode(defaultStarterCode);
    setOutput('');
    setTestResults([]);
    setSubmissionStatus('idle');
    setCopiedToClipboard(false);
  }, [milestone.milestoneId, defaultStarterCode]);

  // Fetch test cases when milestone changes
  useEffect(() => {
    async function fetchTestCases() {
      try {
        setLoadingTestCases(true);
        setTestCasesError(null);
        console.log('Fetching test cases for milestone:', milestone.milestoneId);
        
        const result = await getTestCases(milestone.milestoneId);
        console.log('Test cases fetched:', result);
        
        // Filter to only get non-hidden test cases (sample ones)
        const sampleCases = (result.testCases || [])
          .filter((tc: TestCase) => !tc.isHidden)
          .sort((a: TestCase, b: TestCase) => (a.order || 0) - (b.order || 0));
        
        setSampleTestCases(sampleCases);
        console.log('Sample test cases:', sampleCases);
        
      } catch (error: any) {
        console.error('Failed to fetch test cases:', error);
        setTestCasesError('Failed to load test cases');
      } finally {
        setLoadingTestCases(false);
      }
    }
    
    fetchTestCases();
  }, [milestone.milestoneId]);

  // Lock body scroll when modal is open
  useEffect(() => {
    // Save original body overflow
    const originalOverflow = document.body.style.overflow;
    
    // Lock scroll
    document.body.style.overflow = 'hidden';
    
    // Cleanup: restore original overflow when component unmounts
    return () => {
      document.body.style.overflow = originalOverflow;
    };
  }, []);

  /**
   * Open OnlineGDB in new tab
   */
  const handleOpenInOnlineGDB = () => {
    console.log('🔗 Opening OnlineGDB...');
    
    const onlineGDBUrl = `https://www.onlinegdb.com/`;
    
    console.log('Opening URL:', onlineGDBUrl);
    window.open(onlineGDBUrl, '_blank');
  };

  /**
   * Copy starter code to clipboard
   */
  const handleCopyCode = () => {
    navigator.clipboard.writeText(code).then(() => {
      setCopiedToClipboard(true);
      setTimeout(() => setCopiedToClipboard(false), 3000);
    });
  };

  const handleSubmit = async () => {
    if (!window.confirm(
      '⚠️ IMPORTANT: Before submitting, make sure:\n\n' +
      '✅ You tested your code in OnlineGDB\n' +
      '✅ Your code works with the sample test cases\n' +
      '✅ You copied your final code back to this editor\n\n' +
      'This submission will use Judge0 to test your code against all test cases (including hidden ones).\n\n' +
      'Continue with submission?'
    )) {
      return;
    }

    setIsSubmitting(true);
    setOutput('⏳ Submitting your code to Judge0 for grading...\n\nPlease wait...');
    setTestResults([]);
    setActiveTab('output');
    setSubmissionStatus('idle');

    try {
      console.log('📤 Submitting code to Judge0...');
      
      const result = await submitCode({
        milestoneId: milestone.milestoneId,
        code,
        language: defaultLanguage,
      });

      console.log('✅ Judge0 result:', result);

      if (result.error) {
        setOutput(`❌ Error: ${result.error}`);
        setSubmissionStatus('failed');
      } else if (result.submission) {
        const { status, passedTests, totalTests, testResults: submissionResults } = result.submission;
        
        setTestResults(submissionResults || []);
        
        if (status === 'passed') {
          setOutput(
            `🎉 CONGRATULATIONS! 🎉\n\n` +
            `All ${totalTests} test cases passed!\n\n` +
            `✅ Your solution has been accepted\n` +
            `🏆 Your credential will be awarded shortly\n\n` +
            `Great job! You can now move on to the next problem.`
          );
          setSubmissionStatus('success');
          
          // Call success callback after a delay
          setTimeout(() => {
            if (onSubmitSuccess) {
              onSubmitSuccess();
            }
          }, 2000);
        } else {
          setOutput(
            `📊 Submission Results: ${passedTests}/${totalTests} test cases passed\n\n` +
            `❌ Some test cases failed.\n\n` +
            `Please review the failed test cases below, fix your code in OnlineGDB, and try again.`
          );
          setSubmissionStatus('failed');
        }
      } else {
        setOutput('⚠️ Submission completed but no results received. Please try again.');
      }
    } catch (error: any) {
      console.error('❌ Error submitting code:', error);
      setOutput(
        `❌ Submission Error\n\n` +
        `${error.message || 'Failed to submit code.'}\n\n` +
        `Please check your internet connection and try again.`
      );
      setSubmissionStatus('failed');
    } finally {
      setIsSubmitting(false);
    }
  };

  const getDifficultyColor = (difficulty: string) => {
    switch (difficulty.toLowerCase()) {
      case 'easy':
        return '#28a745';
      case 'medium':
        return '#ffc107';
      case 'hard':
        return '#dc3545';
      default:
        return '#6c757d';
    }
  };

  return (
    <div 
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: 'rgba(0, 0, 0, 0.5)',
        display: 'flex',
        justifyContent: 'center',
        alignItems: 'center',
        zIndex: 1000,
        padding: '20px',
        overflow: 'hidden'
      }}
      onClick={(e) => {
        // Prevent clicks on overlay from propagating
        if (e.target === e.currentTarget) {
          e.stopPropagation();
        }
      }}
      onWheel={(e) => {
        // Prevent scroll events from propagating to background
        e.stopPropagation();
      }}
      onTouchMove={(e) => {
        // Prevent touch scroll on mobile
        e.stopPropagation();
      }}
    >
      <div style={{
        backgroundColor: 'white',
        borderRadius: '12px',
        width: '100%',
        maxWidth: '1400px',
        height: '90vh',
        display: 'flex',
        flexDirection: 'column',
        boxShadow: '0 10px 40px rgba(0, 0, 0, 0.3)'
      }}>
        {/* Header */}
        <div style={{
          padding: '20px 30px',
          borderBottom: '2px solid #e0e0e0',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          backgroundColor: '#f8f9fa'
        }}>
          <div style={{ display: 'flex', gap: '15px', flexDirection: 'column', alignItems: 'flex-start' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '15px' }}>
              <h2 style={{ margin: 0, color: '#333' }}>{milestone.title}</h2>
              <span style={{
                backgroundColor: getDifficultyColor(milestone.difficulty),
                color: 'white',
                padding: '6px 12px',
                borderRadius: '4px',
                fontSize: '14px',
                fontWeight: 'bold',
                textTransform: 'capitalize'
              }}>
                {milestone.difficulty}
              </span>
            </div>
            {milestone.concept && (
              <p style={{
                margin: 0,
                color: '#007bff',
                fontSize: '14px',
                fontWeight: '500',
                fontStyle: 'italic'
              }}>
                📚 Concept: {milestone.concept}
              </p>
            )}
          </div>
          <button
            onClick={onClose}
            style={{
              padding: '8px 16px',
              backgroundColor: '#6c757d',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '14px',
              fontWeight: 'bold'
            }}
          >
            Close
          </button>
        </div>

        {/* Main Content Area */}
        <div style={{
          flex: 1,
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          overflow: 'hidden'
        }}>
          {/* Left Panel: Problem Description / Output */}
          <div style={{
            borderRight: '2px solid #e0e0e0',
            display: 'flex',
            flexDirection: 'column',
            minHeight: 0
          }}>
            {/* Tabs */}
            <div style={{
              display: 'flex',
              borderBottom: '2px solid #e0e0e0',
              backgroundColor: '#f8f9fa'
            }}>
              <button
                onClick={() => setActiveTab('description')}
                style={{
                  flex: 1,
                  padding: '15px',
                  border: 'none',
                  backgroundColor: activeTab === 'description' ? 'white' : 'transparent',
                  borderBottom: activeTab === 'description' ? '3px solid #007bff' : 'none',
                  cursor: 'pointer',
                  fontSize: '14px',
                  fontWeight: activeTab === 'description' ? 'bold' : 'normal',
                  color: activeTab === 'description' ? '#007bff' : '#666'
                }}
              >
                📋 Description
              </button>
              <button
                onClick={() => setActiveTab('output')}
                style={{
                  flex: 1,
                  padding: '15px',
                  border: 'none',
                  backgroundColor: activeTab === 'output' ? 'white' : 'transparent',
                  borderBottom: activeTab === 'output' ? '3px solid #007bff' : 'none',
                  cursor: 'pointer',
                  fontSize: '14px',
                  fontWeight: activeTab === 'output' ? 'bold' : 'normal',
                  color: activeTab === 'output' ? '#007bff' : '#666'
                }}
              >
                📊 Submission Results
              </button>
            </div>

            {/* Tab Content */}
            <div style={{
              flex: 1,
              minHeight: 0,
              overflow: 'auto',
              padding: '20px'
            }}>
              {activeTab === 'description' ? (
                <div>
                  <h3 style={{ color: '#333', marginTop: 0 }}>Problem Description</h3>
                  <p style={{ color: '#666', lineHeight: '1.6', whiteSpace: 'pre-wrap' }}>
                    {milestone.description}
                  </p>

                  {/* Sample Test Cases */}
                  {loadingTestCases ? (
                    <div style={{
                      marginTop: '20px',
                      padding: '15px',
                      backgroundColor: '#f8f9fa',
                      borderRadius: '8px',
                      border: '1px solid #e0e0e0',
                      textAlign: 'center',
                      color: '#666'
                    }}>
                      Loading test cases...
                    </div>
                  ) : testCasesError ? (
                    <div style={{
                      marginTop: '20px',
                      padding: '15px',
                      backgroundColor: '#f8d7da',
                      borderRadius: '8px',
                      border: '1px solid #f5c6cb',
                      color: '#721c24'
                    }}>
                      ⚠️ {testCasesError}
                    </div>
                  ) : sampleTestCases.length > 0 ? (
                    <div style={{
                      marginTop: '20px',
                      padding: '15px',
                      backgroundColor: '#f8f9fa',
                      borderRadius: '8px',
                      border: '1px solid #e0e0e0'
                    }}>
                      <h4 style={{ color: '#333', marginTop: 0 }}>📝 Sample Test Cases</h4>
                      <p style={{ color: '#666', fontSize: '13px', marginBottom: '15px' }}>
                        Use these examples to test your code in OnlineGDB before submitting.
                      </p>
                      {sampleTestCases.map((testCase, index) => (
                        <div key={testCase.testCaseId || index} style={{ marginBottom: '15px' }}>
                          <p style={{ margin: '5px 0', color: '#666', fontWeight: 'bold' }}>
                            Test Case {index + 1}:
                          </p>
                          <div style={{ margin: '5px 0', color: '#666' }}>
                            <strong>Input:</strong>
                            <pre style={{
                              background: '#fff',
                              padding: '8px',
                              borderRadius: '4px',
                              margin: '5px 0',
                              fontSize: '13px',
                              color: '#333',
                              border: '1px solid #dee2e6'
                            }}>
                              {testCase.input}
                            </pre>
                          </div>
                          <div style={{ margin: '5px 0', color: '#666' }}>
                            <strong>Expected Output:</strong>
                            <pre style={{
                              background: '#fff',
                              padding: '8px',
                              borderRadius: '4px',
                              margin: '5px 0',
                              fontSize: '13px',
                              color: '#333',
                              border: '1px solid #dee2e6'
                            }}>
                              {testCase.expectedOutput}
                            </pre>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div style={{
                      marginTop: '20px',
                      padding: '15px',
                      backgroundColor: '#fff3cd',
                      borderRadius: '8px',
                      border: '1px solid #ffc107',
                      color: '#856404'
                    }}>
                      ℹ️ No sample test cases available. Submit your solution to test against hidden test cases.
                    </div>
                  )}

                  {/* Instructions */}
                  <div style={{
                    marginTop: '20px',
                    padding: '15px',
                    backgroundColor: '#e7f3ff',
                    borderRadius: '8px',
                    border: '2px solid #0066cc'
                  }}>
                    <h4 style={{ color: '#0066cc', marginTop: 0 }}>📚 How to Solve This Problem</h4>
                    <ol style={{ color: '#333', lineHeight: '1.8', paddingLeft: '20px' }}>
                      <li>
                        <strong>Click "📋 Copy Code"</strong> button below to copy the starter code
                      </li>
                      <li>
                        <strong>Click "🔗 Open OnlineGDB"</strong> to open the external IDE in a new tab
                      </li>
                      <li>
                        <strong>Paste the starter code</strong> in OnlineGDB editor
                      </li>
                      <li>
                        <strong>Write your solution</strong> in OnlineGDB
                      </li>
                      <li>
                        <strong>Test with sample inputs</strong> shown above (unlimited testing - FREE!)
                      </li>
                      <li>
                        <strong>Once working, copy your final code</strong> from OnlineGDB
                      </li>
                      <li>
                        <strong>Paste it back</strong> in the editor (right side)
                      </li>
                      <li>
                        <strong>Click "Submit"</strong> to run against all test cases (Judge0)
                      </li>
                    </ol>

                    <div style={{
                      display: 'flex',
                      gap: '10px',
                      marginTop: '15px',
                      flexWrap: 'wrap'
                    }}>
                      <button
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          console.log('📋 Copy Code button clicked!');
                          handleCopyCode();
                        }}
                        style={{
                          padding: '12px 20px',
                          background: copiedToClipboard ? '#28a745' : '#007bff',
                          color: 'white',
                          border: 'none',
                          borderRadius: '6px',
                          cursor: 'pointer',
                          fontSize: '14px',
                          fontWeight: 'bold',
                          transition: 'background 0.3s',
                          boxShadow: '0 4px 6px rgba(0,0,0,0.1)',
                          pointerEvents: 'auto'
                        }}
                      >
                        {copiedToClipboard ? '✅ Copied!' : '📋 Copy Code'}
                      </button>

                      <button
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          console.log('🔗 Open OnlineGDB button clicked!');
                          handleOpenInOnlineGDB();
                        }}
                        style={{
                          padding: '12px 20px',
                          background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)',
                          color: 'white',
                          border: 'none',
                          borderRadius: '6px',
                          cursor: 'pointer',
                          fontSize: '14px',
                          fontWeight: 'bold',
                          boxShadow: '0 4px 6px rgba(0,0,0,0.1)',
                          transition: 'transform 0.2s',
                          pointerEvents: 'auto'
                        }}
                        onMouseEnter={(e) => {
                          e.currentTarget.style.transform = 'translateY(-2px)';
                          e.currentTarget.style.boxShadow = '0 6px 12px rgba(0,0,0,0.15)';
                        }}
                        onMouseLeave={(e) => {
                          e.currentTarget.style.transform = 'translateY(0)';
                          e.currentTarget.style.boxShadow = '0 4px 6px rgba(0,0,0,0.1)';
                        }}
                      >
                        🔗 Open OnlineGDB
                      </button>
                    </div>
                  </div>

                  {/* Constraints */}
                  <div style={{
                    marginTop: '20px',
                    padding: '15px',
                    backgroundColor: '#fff3cd',
                    borderRadius: '8px',
                    border: '1px solid #ffc107'
                  }}>
                    <h4 style={{ color: '#856404', marginTop: 0 }}>⚙️ Constraints</h4>
                    <ul style={{ color: '#856404', lineHeight: '1.6', margin: 0 }}>
                      <li>Language: <strong>{defaultLanguage.toUpperCase()}</strong></li>
                      <li>Time Limit: <strong>{milestone.timeLimit || 5000}ms</strong></li>
                      <li>Memory Limit: <strong>{(milestone.memoryLimit || 256000) / 1024}MB</strong></li>
                    </ul>
                  </div>
                </div>
              ) : (
                <div>
                  <h3 style={{ color: '#333', marginTop: 0 }}>Submission Results</h3>
                  <pre style={{
                    backgroundColor: '#f5f5f5',
                    padding: '15px',
                    borderRadius: '8px',
                    overflow: 'auto',
                    fontSize: '14px',
                    lineHeight: '1.5',
                    color: '#333',
                    minHeight: '100px',
                    border: '1px solid #e0e0e0',
                    whiteSpace: 'pre-wrap'
                  }}>
                    {output || 'Click "Submit" to see results here...'}
                  </pre>

                  {submissionStatus === 'success' && (
                    <div style={{
                      marginTop: '20px',
                      padding: '20px',
                      backgroundColor: '#d4edda',
                      borderRadius: '8px',
                      border: '2px solid #28a745',
                      textAlign: 'center'
                    }}>
                      <div style={{ fontSize: '48px', marginBottom: '10px' }}>🎉</div>
                      <h3 style={{ color: '#155724', margin: '0 0 10px 0' }}>
                        Submission Accepted!
                      </h3>
                      <p style={{ color: '#155724', margin: 0, fontSize: '16px' }}>
                        Congratulations! Your credential will be awarded shortly.
                      </p>
                    </div>
                  )}

                  {testResults.length > 0 && (
                    <div style={{ marginTop: '20px' }}>
                      <h3 style={{ color: '#333' }}>Test Case Results</h3>
                      {testResults.map((result, index) => (
                        <TestCaseResult key={index} result={result} index={index} />
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Right Panel: Code Editor */}
          <div style={{
            display: 'flex',
            flexDirection: 'column'
          }}>
            {/* Editor Header */}
            <div style={{
              padding: '15px 20px',
              backgroundColor: '#f8f9fa',
              borderBottom: '2px solid #e0e0e0',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center'
            }}>
              <span style={{
                fontSize: '14px',
                fontWeight: 'bold',
                color: '#333'
              }}>
                💻 Code Editor - {defaultLanguage.toUpperCase()}
              </span>
              <div style={{ display: 'flex', gap: '10px' }}>
                <button
                  onClick={handleSubmit}
                  disabled={isSubmitting}
                  style={{
                    padding: '10px 20px',
                    backgroundColor: isSubmitting ? '#6c757d' : '#28a745',
                    color: 'white',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: isSubmitting ? 'not-allowed' : 'pointer',
                    fontSize: '14px',
                    fontWeight: 'bold',
                    opacity: isSubmitting ? 0.6 : 1
                  }}
                  title="Submit for final grading (uses Judge0)"
                >
                  {isSubmitting ? '⏳ Submitting...' : '✅ Submit'}
                </button>
              </div>
            </div>

            {/* Monaco Editor */}
            <div style={{ flex: 1 }}>
              <Editor
                height="100%"
                language={defaultLanguage}
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
                  padding: { top: 10 }
                }}
              />
            </div>

            {/* Editor Footer with Instructions */}
            <div style={{
              padding: '15px 20px',
              backgroundColor: '#fff3cd',
              borderTop: '2px solid #ffc107',
              fontSize: '13px',
              color: '#856404'
            }}>
              <strong>💡 Workflow:</strong> Copy code → Test in OnlineGDB → Paste final solution here → Submit
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Helper function to get default starter code based on language
function getDefaultStarterCode(language: string): string {
  const starterCodes: { [key: string]: string } = {
    python: `# Write your solution here
def solution():
    # Your code here
    pass

# Do not modify below this line
if __name__ == "__main__":
    solution()
`,
    javascript: `// Write your solution here
function solution() {
    // Your code here
}

// Do not modify below this line
solution();
`,
    java: `public class Solution {
    // Write your solution here
    public static void main(String[] args) {
        // Your code here
    }
}
`,
    cpp: `#include <iostream>
using namespace std;

// Write your solution here
int main() {
    // Your code here
    return 0;
}
`,
    c: `#include <stdio.h>

// Write your solution here
int main() {
    // Your code here
    return 0;
}
`
  };

  return starterCodes[language] || starterCodes['python'];
}