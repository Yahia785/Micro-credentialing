import { useState, useEffect } from 'react';
import { getAllMilestones, createMilestone, deleteMilestone } from '../api/milestones';
import { createTestCasesBatch } from '../api/testcases';
import { CodeEditor } from './CodeEditor';
import { ProctoringInstructions } from './proctoring/ProctoringInstructions';

interface Problem {
  milestoneId: string;
  title: string;
  description: string;
  concept?: string;
  difficulty: 'easy' | 'medium' | 'hard';
  language?: string;
  starterCode?: string;
  timeLimit?: number;
  memoryLimit?: number;
  testCaseCount?: number;
  createdAt: string;
  updatedAt: string;
}

interface TestCaseInput {
  inputs: string[];
  expectedOutput: string;
  isHidden: boolean;
}

interface ProblemsTabProps {
  userProfile: any;
  onRefreshNeeded?: () => void;
}

export function ProblemsTab({ userProfile, onRefreshNeeded }: ProblemsTabProps) {
  const userRole = userProfile?.role || 'user';
  const isAdmin = userRole === 'admin';

  const [problems, setProblems] = useState<Problem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isAddingProblem, setIsAddingProblem] = useState(false);
  const [selectedProblem, setSelectedProblem] = useState<Problem | null>(null);
  const [creationStep, setCreationStep] = useState<1 | 2>(1);
  const [createdProblemId, setCreatedProblemId] = useState<string | null>(null);
  const [showProctoringInstructions, setShowProctoringInstructions] = useState(false);
  const [pendingProblem, setPendingProblem] = useState<Problem | null>(null);
  const [webcamStream, setWebcamStream] = useState<MediaStream | null>(null);
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);

  const [newProblem, setNewProblem] = useState({
    title: '',
    description: '',
    concept: '',
    difficulty: 'medium' as const,
    language: 'python',
    starterCode: '',
    timeLimit: 5000,
    memoryLimit: 256000
  });

  const [testCases, setTestCases] = useState<TestCaseInput[]>([
    { inputs: ['', ''], expectedOutput: '', isHidden: false }
  ]);

  useEffect(() => {
    loadProblems();
  }, []);

  async function loadProblems() {
    try {
      setLoading(true);
      setError(null);
      console.log('Fetching problems from backend...');
      
      const result = await getAllMilestones();
      console.log('Problems loaded:', result);
      
      setProblems(result.milestones || []);
    } catch (err: any) {
      console.error('Failed to load problems:', err);
      setError('Failed to load problems from database');
    } finally {
      setLoading(false);
    }
  }

  const handleAddProblem = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!newProblem.title.trim() || !newProblem.description.trim()) {
      setError('Title and description are required');
      return;
    }

    try {
      setError(null);
      console.log('Creating problem with language:', newProblem.language);
      
      const result = await createMilestone({
        title: newProblem.title,
        description: newProblem.description,
        concept: newProblem.concept,
        difficulty: newProblem.difficulty,
        language: newProblem.language,
        starterCode: newProblem.starterCode,
        timeLimit: newProblem.timeLimit,
        memoryLimit: newProblem.memoryLimit
      });
      
      console.log('Problem created with response:', result);
      
      setCreatedProblemId(result.milestone.milestoneId);
      setCreationStep(2);
      
    } catch (err: any) {
      console.error('Failed to create problem:', err);
      setError('Failed to create problem. Please try again.');
    }
  };

  const handleAddTestCases = async (e: React.FormEvent) => {
    e.preventDefault();
    
    const validTestCases = testCases.filter(tc => {
      const hasInputs = tc.inputs.some(input => input.trim() !== '');
      const hasOutput = tc.expectedOutput.trim() !== '';
      return hasInputs && hasOutput;
    });

    if (validTestCases.length === 0) {
      setError('At least one test case with inputs and expected output is required');
      return;
    }

    if (!createdProblemId) {
      setError('Problem ID not found. Please try again.');
      return;
    }

    try {
      setError(null);
      console.log('Creating test cases for problem:', createdProblemId);
      
      const testCasesToCreate = validTestCases.map((tc, index) => {
        const inputString = tc.inputs
          .filter(input => input.trim() !== '')
          .join('\n');
        
        return {
          input: inputString,
          expectedOutput: tc.expectedOutput,
          isHidden: tc.isHidden,
          includeInJudge0: true,
          weight: 1,
          order: index,
          testTier: 'standard'
        };
      });

      console.log('Test cases to create:', testCasesToCreate);

      const result = await createTestCasesBatch(createdProblemId, testCasesToCreate);
      console.log('Test cases created:', result);
      
      await loadProblems();
      
      setNewProblem({
        title: '',
        description: '',
        concept: '',
        difficulty: 'medium',
        language: 'python',
        starterCode: '',
        timeLimit: 5000,
        memoryLimit: 256000
      });
      setTestCases([{ inputs: ['', ''], expectedOutput: '', isHidden: false }]);
      setCreationStep(1);
      setCreatedProblemId(null);
      setIsAddingProblem(false);
      
    } catch (err: any) {
      console.error('Failed to create test cases:', err);
      setError('Failed to create test cases. Please try again.');
    }
  };

  const handleAddTestCaseRow = () => {
    setTestCases([...testCases, { inputs: ['', ''], expectedOutput: '', isHidden: false }]);
  };

  const handleRemoveTestCase = (index: number) => {
    if (testCases.length > 1) {
      setTestCases(testCases.filter((_, i) => i !== index));
    }
  };

  const handleAddInputField = (testCaseIndex: number) => {
    const updated = [...testCases];
    updated[testCaseIndex].inputs.push('');
    setTestCases(updated);
  };

  const handleRemoveInputField = (testCaseIndex: number, inputIndex: number) => {
    const updated = [...testCases];
    if (updated[testCaseIndex].inputs.length > 1) {
      updated[testCaseIndex].inputs = updated[testCaseIndex].inputs.filter((_, i) => i !== inputIndex);
      setTestCases(updated);
    }
  };

  const handleInputChange = (testCaseIndex: number, inputIndex: number, value: string) => {
    const updated = [...testCases];
    updated[testCaseIndex].inputs[inputIndex] = value;
    setTestCases(updated);
  };

  const handleOutputChange = (testCaseIndex: number, value: string) => {
    const updated = [...testCases];
    updated[testCaseIndex].expectedOutput = value;
    setTestCases(updated);
  };

  const handleHiddenChange = (testCaseIndex: number, value: boolean) => {
    const updated = [...testCases];
    updated[testCaseIndex].isHidden = value;
    setTestCases(updated);
  };

  const handleCancelProblemCreation = () => {
    setIsAddingProblem(false);
    setCreationStep(1);
    setCreatedProblemId(null);
    setNewProblem({
      title: '',
      description: '',
      concept: '',
      difficulty: 'medium',
      language: 'python',
      starterCode: '',
      timeLimit: 5000,
      memoryLimit: 256000
    });
    setTestCases([{ inputs: ['', ''], expectedOutput: '', isHidden: false }]);
    setError(null);
  };

  const handleBackToStep1 = () => {
    setCreationStep(1);
    setError(null);
  };

  const handleDeleteProblem = async (milestoneId: string) => {
    if (!window.confirm('Are you sure you want to delete this problem? This will also delete all associated test cases.')) {
      return;
    }

    try {
      setError(null);
      console.log('Deleting problem:', milestoneId);
      
      await deleteMilestone(milestoneId);
      console.log('Problem deleted successfully');
      
      setProblems(problems.filter(p => p.milestoneId !== milestoneId));
    } catch (err: any) {
      console.error('Failed to delete problem:', err);
      setError('Failed to delete problem. Please try again.');
    }
  };

const handleOpenEditor = (problem: Problem) => {
    // Check if problem is already completed
    const isCompleted = userProfile?.completedMilestones?.some(
      (m: any) => m.milestoneId === problem.milestoneId
    );
    
    if (isCompleted) {
      // Skip proctoring for completed problems - open directly
      console.log('Opening completed problem (view mode):', problem.title);
      setSelectedProblem(problem);
      // No streams needed for viewing
      setWebcamStream(null);
      setScreenStream(null);
    } else {
      // Show proctoring instructions for unsolved problems
      console.log('Opening proctoring instructions for problem:', problem.title);
      setPendingProblem(problem);
      setShowProctoringInstructions(true);
    }
  };


  const handleProctoringGranted = (webcam: MediaStream, screen: MediaStream) => {
    console.log('✅ Proctoring permissions granted');
    setWebcamStream(webcam);
    setScreenStream(screen);
    setShowProctoringInstructions(false);
    
    if (pendingProblem) {
      setSelectedProblem(pendingProblem);
    }
  };

  const handleProctoringCancelled = () => {
    console.log('❌ Proctoring cancelled');
    setShowProctoringInstructions(false);
    setPendingProblem(null);
  };

const handleCloseEditor = async () => {
    // Stop recording streams when closing editor
    if (webcamStream) {
      webcamStream.getTracks().forEach(track => track.stop());
      setWebcamStream(null);
    }
    if (screenStream) {
      screenStream.getTracks().forEach(track => track.stop());
      setScreenStream(null);
    }
    
    // Reload problems list
    console.log('🔄 Reloading problems before closing editor...');
    await loadProblems();
    
    // Trigger user profile refresh in parent component
    if (onRefreshNeeded) {
      console.log('🔄 Triggering user profile refresh...');
      onRefreshNeeded();
    }
    
    setSelectedProblem(null);
    setPendingProblem(null);
  };

const handleSubmitSuccess = async () => {
    console.log('🎉 Submission successful, reloading data...');
    await loadProblems();
    
    // Trigger user profile refresh in parent component
    if (onRefreshNeeded) {
      onRefreshNeeded();
    }
  };
  
  const getDifficultyColor = (difficulty: string) => {
    switch (difficulty) {
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

  const getTestCaseStats = () => {
    const visible = testCases.filter(tc => {
      const hasInputs = tc.inputs.some(input => input.trim() !== '');
      const hasOutput = tc.expectedOutput.trim() !== '';
      return !tc.isHidden && hasInputs && hasOutput;
    }).length;
    
    const hidden = testCases.filter(tc => {
      const hasInputs = tc.inputs.some(input => input.trim() !== '');
      const hasOutput = tc.expectedOutput.trim() !== '';
      return tc.isHidden && hasInputs && hasOutput;
    }).length;
    
    return { visible, hidden, total: visible + hidden };
  };

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: '40px' }}>
        <p style={{ color: '#333' }}>Loading problems...</p>
      </div>
    );
  }

  return (
    <div style={{ padding: '20px' }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '20px'
      }}>
        <div>
          <h2 style={{ marginBottom: '10px', color: '#333' }}>Coding Problems</h2>
          <p style={{ color: '#666', margin: 0 }}>
            Total Problems: <strong>{problems.length}</strong>
          </p>
        </div>
        {isAdmin && (
          <button
            onClick={() => {
              setIsAddingProblem(!isAddingProblem);
              setError(null);
              if (isAddingProblem) {
                handleCancelProblemCreation();
              }
            }}
            style={{
              padding: '10px 20px',
              background: '#007bff',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer',
              fontSize: '14px',
              fontWeight: 'bold'
            }}
          >
            {isAddingProblem ? 'Cancel' : '➕ Add Problem'}
          </button>
        )}
      </div>

      {error && (
        <div style={{
          background: '#f8d7da',
          color: '#721c24',
          padding: '15px',
          borderRadius: '8px',
          marginBottom: '20px',
          border: '1px solid #f5c6cb'
        }}>
          {error}
        </div>
      )}

      {isAdmin && isAddingProblem && (
        <div style={{
          background: '#e7f3ff',
          padding: '15px',
          borderRadius: '8px',
          marginBottom: '20px',
          display: 'flex',
          alignItems: 'center',
          gap: '20px',
          border: '1px solid #0066cc'
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div style={{
              width: '30px',
              height: '30px',
              borderRadius: '50%',
              background: creationStep === 1 ? '#007bff' : '#28a745',
              color: 'white',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 'bold'
            }}>
              {creationStep === 1 ? '1' : '✓'}
            </div>
            <span style={{ fontWeight: creationStep === 1 ? 'bold' : 'normal', color: '#333' }}>
              Problem Details
            </span>
          </div>
          
          <div style={{ width: '40px', height: '2px', background: creationStep === 2 ? '#28a745' : '#ccc' }} />
          
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div style={{
              width: '30px',
              height: '30px',
              borderRadius: '50%',
              background: creationStep === 2 ? '#007bff' : '#ccc',
              color: 'white',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontWeight: 'bold'
            }}>
              2
            </div>
            <span style={{ fontWeight: creationStep === 2 ? 'bold' : 'normal', color: '#333' }}>
              Add Test Cases
            </span>
          </div>
        </div>
      )}

      {isAdmin && isAddingProblem && creationStep === 1 && (
        <form onSubmit={handleAddProblem} style={{
          background: '#f8f9fa',
          padding: '20px',
          borderRadius: '8px',
          marginBottom: '20px',
          border: '1px solid #dee2e6'
        }}>
          <h3 style={{ color: '#333', marginTop: 0 }}>Step 1: Create New Problem</h3>
          
          <div style={{ marginBottom: '15px' }}>
            <label style={{ 
              display: 'block', 
              marginBottom: '5px', 
              fontWeight: 'bold',
              color: '#333'
            }}>
              Problem Title: <span style={{ color: 'red' }}>*</span>
            </label>
            <input
              type="text"
              value={newProblem.title}
              onChange={(e) => setNewProblem({ ...newProblem, title: e.target.value })}
              placeholder="e.g., Two Sum"
              style={{
                width: '100%',
                padding: '10px',
                fontSize: '14px',
                border: '1px solid #ced4da',
                borderRadius: '4px',
                boxSizing: 'border-box'
              }}
              required
            />
          </div>

          <div style={{ marginBottom: '15px' }}>
            <label style={{ 
              display: 'block', 
              marginBottom: '5px', 
              fontWeight: 'bold',
              color: '#333'
            }}>
              Concept/Topic:
            </label>
            <input
              type="text"
              value={newProblem.concept}
              onChange={(e) => setNewProblem({ ...newProblem, concept: e.target.value })}
              placeholder="e.g., Arrays, Linked Lists, Dynamic Programming"
              style={{
                width: '100%',
                padding: '10px',
                fontSize: '14px',
                border: '1px solid #ced4da',
                borderRadius: '4px',
                boxSizing: 'border-box'
              }}
            />
            <small style={{ color: '#666', display: 'block', marginTop: '5px' }}>
              This will be shown to users before they start solving
            </small>
          </div>

          <div style={{ marginBottom: '15px' }}>
            <label style={{ 
              display: 'block', 
              marginBottom: '5px', 
              fontWeight: 'bold',
              color: '#333'
            }}>
              Description: <span style={{ color: 'red' }}>*</span>
            </label>
            <textarea
              value={newProblem.description}
              onChange={(e) => setNewProblem({ ...newProblem, description: e.target.value })}
              placeholder="Describe the problem in detail..."
              style={{
                width: '100%',
                padding: '10px',
                fontSize: '14px',
                border: '1px solid #ced4da',
                borderRadius: '4px',
                minHeight: '120px',
                boxSizing: 'border-box',
                fontFamily: 'inherit'
              }}
              required
            />
            <small style={{ color: '#666', display: 'block', marginTop: '5px' }}>
              This will be hidden until user opens the code editor
            </small>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px', marginBottom: '15px' }}>
            <div>
              <label style={{ 
                display: 'block', 
                marginBottom: '5px', 
                fontWeight: 'bold',
                color: '#333'
              }}>
                Difficulty:
              </label>
              <select
                value={newProblem.difficulty}
                onChange={(e) => setNewProblem({ ...newProblem, difficulty: e.target.value as any })}
                style={{
                  width: '100%',
                  padding: '10px',
                  fontSize: '14px',
                  border: '1px solid #ced4da',
                  borderRadius: '4px'
                }}
              >
                <option value="easy">Easy</option>
                <option value="medium">Medium</option>
                <option value="hard">Hard</option>
              </select>
            </div>

            <div>
              <label style={{ 
                display: 'block', 
                marginBottom: '5px', 
                fontWeight: 'bold',
                color: '#333'
              }}>
                Language: <span style={{ color: 'red' }}>*</span>
              </label>
              <select
                value={newProblem.language}
                onChange={(e) => {
                  console.log('Language changed to:', e.target.value);
                  setNewProblem({ ...newProblem, language: e.target.value });
                }}
                style={{
                  width: '100%',
                  padding: '10px',
                  fontSize: '14px',
                  border: '1px solid #ced4da',
                  borderRadius: '4px'
                }}
              >
                <option value="python">Python</option>
                <option value="javascript">JavaScript</option>
                <option value="java">Java</option>
                <option value="cpp">C++</option>
                <option value="c">C</option>
              </select>
            </div>
          </div>

          <div style={{ marginBottom: '15px' }}>
            <label style={{ 
              display: 'block', 
              marginBottom: '5px', 
              fontWeight: 'bold',
              color: '#333'
            }}>
              Starter Code (Optional):
            </label>
            <textarea
              value={newProblem.starterCode}
              onChange={(e) => setNewProblem({ ...newProblem, starterCode: e.target.value })}
              placeholder="Leave empty for default template..."
              style={{
                width: '100%',
                padding: '10px',
                fontSize: '13px',
                border: '1px solid #ced4da',
                borderRadius: '4px',
                minHeight: '100px',
                boxSizing: 'border-box',
                fontFamily: 'monospace'
              }}
            />
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px', marginBottom: '15px' }}>
            <div>
              <label style={{ 
                display: 'block', 
                marginBottom: '5px', 
                fontWeight: 'bold',
                color: '#333'
              }}>
                Time Limit (ms):
              </label>
              <input
                type="number"
                value={newProblem.timeLimit}
                onChange={(e) => setNewProblem({ ...newProblem, timeLimit: parseInt(e.target.value) || 5000 })}
                style={{
                  width: '100%',
                  padding: '10px',
                  fontSize: '14px',
                  border: '1px solid #ced4da',
                  borderRadius: '4px'
                }}
              />
            </div>

            <div>
              <label style={{ 
                display: 'block', 
                marginBottom: '5px', 
                fontWeight: 'bold',
                color: '#333'
              }}>
                Memory Limit (KB):
              </label>
              <input
                type="number"
                value={newProblem.memoryLimit}
                onChange={(e) => setNewProblem({ ...newProblem, memoryLimit: parseInt(e.target.value) || 256000 })}
                style={{
                  width: '100%',
                  padding: '10px',
                  fontSize: '14px',
                  border: '1px solid #ced4da',
                  borderRadius: '4px'
                }}
              />
            </div>
          </div>

          <div style={{ display: 'flex', gap: '10px' }}>
            <button
              type="submit"
              style={{
                padding: '10px 20px',
                background: '#007bff',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
                fontSize: '14px',
                fontWeight: 'bold'
              }}
            >
              Next: Add Test Cases →
            </button>
            
            <button
              type="button"
              onClick={handleCancelProblemCreation}
              style={{
                padding: '10px 20px',
                background: '#6c757d',
                color: 'white',
                border: 'none',
                borderRadius: '4px',
                cursor: 'pointer',
                fontSize: '14px',
                fontWeight: 'bold'
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      {isAdmin && isAddingProblem && creationStep === 2 && (
        <form onSubmit={handleAddTestCases} style={{
          background: '#f8f9fa',
          padding: '20px',
          borderRadius: '8px',
          marginBottom: '20px',
          border: '1px solid #dee2e6'
        }}>
          <h3 style={{ color: '#333', marginTop: 0 }}>Step 2: Add Test Cases</h3>
          
          <div style={{
            background: '#e7f3ff',
            padding: '15px',
            borderRadius: '8px',
            marginBottom: '20px',
            border: '1px solid #0066cc'
          }}>
            {/* <h4 style={{ color: '#0066cc', marginTop: 0, marginBottom: '10px' }}>ℹ️ How Test Cases Work</h4>
            <ul style={{ color: '#333', marginBottom: 0, paddingLeft: '20px' }}>
              <li>Each input field represents one parameter</li>
              <li>Inputs will be sent to Judge0 as separate lines (one per parameter)</li>
              <li>Click "+ Add Input Field" to add more parameters</li>
              <li>Mark as "Hidden" to use for grading only</li>
            </ul> */}
          </div>

          <div style={{
            background: '#d4edda',
            padding: '12px',
            borderRadius: '6px',
            marginBottom: '20px',
            border: '1px solid #28a745'
          }}>
            <strong>Test Cases Summary:</strong> {getTestCaseStats().total} total 
            ({getTestCaseStats().visible} sample, {getTestCaseStats().hidden} hidden)
          </div>

          {testCases.map((testCase, testCaseIndex) => (
            <div 
              key={testCaseIndex}
              style={{
                background: 'white',
                padding: '20px',
                borderRadius: '8px',
                marginBottom: '20px',
                border: '2px solid #dee2e6',
                boxShadow: '0 2px 4px rgba(0,0,0,0.05)'
              }}
            >
              <div style={{ 
                display: 'flex', 
                justifyContent: 'space-between', 
                alignItems: 'center',
                marginBottom: '15px',
                paddingBottom: '10px',
                borderBottom: '2px solid #e9ecef'
              }}>
                <h4 style={{ margin: 0, color: '#333', fontSize: '16px' }}>
                  Test Case {testCaseIndex + 1}
                </h4>
                {testCases.length > 1 && (
                  <button
                    type="button"
                    onClick={() => handleRemoveTestCase(testCaseIndex)}
                    style={{
                      padding: '6px 12px',
                      background: '#dc3545',
                      color: 'white',
                      border: 'none',
                      borderRadius: '4px',
                      cursor: 'pointer',
                      fontSize: '12px',
                      fontWeight: 'bold'
                    }}
                  >
                    🗑️ Remove Test Case
                  </button>
                )}
              </div>

              <div style={{ marginBottom: '15px' }}>
                <label style={{ 
                  display: 'block', 
                  marginBottom: '10px', 
                  fontWeight: 'bold',
                  color: '#333',
                  fontSize: '14px'
                }}>
                  Inputs:
                </label>
                
                <div style={{ 
                  display: 'grid', 
                  gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
                  gap: '10px',
                  marginBottom: '10px'
                }}>
                  {testCase.inputs.map((input, inputIndex) => (
                    <div key={inputIndex} style={{ position: 'relative' }}>
                      <label style={{ 
                        display: 'block', 
                        marginBottom: '5px',
                        fontSize: '12px',
                        color: '#666',
                        fontWeight: '500'
                      }}>
                        Input {inputIndex + 1}:
                      </label>
                      <div style={{ display: 'flex', gap: '5px', alignItems: 'center' }}>
                        <input
                          type="text"
                          value={input}
                          onChange={(e) => handleInputChange(testCaseIndex, inputIndex, e.target.value)}
                          placeholder={`Value ${inputIndex + 1}`}
                          style={{
                            flex: 1,
                            padding: '10px',
                            fontSize: '14px',
                            border: '1px solid #ced4da',
                            borderRadius: '4px',
                            fontFamily: 'monospace'
                          }}
                        />
                        {testCase.inputs.length > 1 && (
                          <button
                            type="button"
                            onClick={() => handleRemoveInputField(testCaseIndex, inputIndex)}
                            style={{
                              padding: '8px',
                              background: '#dc3545',
                              color: 'white',
                              border: 'none',
                              borderRadius: '4px',
                              cursor: 'pointer',
                              fontSize: '12px',
                              minWidth: '32px'
                            }}
                            title="Remove this input"
                          >
                            ✕
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>

                <button
                  type="button"
                  onClick={() => handleAddInputField(testCaseIndex)}
                  style={{
                    padding: '8px 16px',
                    background: '#28a745',
                    color: 'white',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: 'pointer',
                    fontSize: '13px',
                    fontWeight: 'bold'
                  }}
                >
                  + Add Input Field
                </button>
              </div>

              <div style={{ marginBottom: '15px' }}>
                <label style={{ 
                  display: 'block', 
                  marginBottom: '5px', 
                  fontWeight: 'bold',
                  color: '#333',
                  fontSize: '14px'
                }}>
                  Expected Output:
                </label>
                <textarea
                  value={testCase.expectedOutput}
                  onChange={(e) => handleOutputChange(testCaseIndex, e.target.value)}
                  placeholder="e.g., 5"
                  style={{
                    width: '100%',
                    padding: '10px',
                    fontSize: '14px',
                    border: '1px solid #ced4da',
                    borderRadius: '4px',
                    minHeight: '60px',
                    boxSizing: 'border-box',
                    fontFamily: 'monospace'
                  }}
                  required
                />
              </div>

              <div style={{ 
                display: 'flex', 
                alignItems: 'center', 
                gap: '10px',
                padding: '10px',
                background: '#f8f9fa',
                borderRadius: '4px'
              }}>
                <label style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '8px',
                  cursor: 'pointer',
                  fontSize: '14px',
                  color: '#333',
                  margin: 0
                }}>
                  <input
                    type="checkbox"
                    checked={testCase.isHidden}
                    onChange={(e) => handleHiddenChange(testCaseIndex, e.target.checked)}
                    style={{ cursor: 'pointer', width: '18px', height: '18px' }}
                  />
                  <span style={{ fontWeight: testCase.isHidden ? 'bold' : 'normal' }}>
                    {testCase.isHidden ? '🔒 Hidden (for grading only)' : '👁️ Sample (visible to users)'}
                  </span>
                </label>
              </div>
            </div>
          ))}

          <button
            type="button"
            onClick={handleAddTestCaseRow}
            style={{
              padding: '12px 20px',
              background: '#007bff',
              color: 'white',
              border: 'none',
              borderRadius: '6px',
              cursor: 'pointer',
              fontSize: '14px',
              fontWeight: 'bold',
              marginBottom: '20px',
              width: '100%',
              boxShadow: '0 2px 4px rgba(0,0,0,0.1)'
            }}
          >
            ➕ Add Another Test Case
          </button>

          <div style={{ display: 'flex', gap: '10px', paddingTop: '20px', borderTop: '2px solid #dee2e6' }}>
            <button
              type="submit"
              style={{
                padding: '12px 24px',
                background: '#28a745',
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                cursor: 'pointer',
                fontSize: '15px',
                fontWeight: 'bold',
                flex: 1
              }}
            >
              ✅ Complete Problem Creation
            </button>
            
            <button
              type="button"
              onClick={handleBackToStep1}
              style={{
                padding: '12px 24px',
                background: '#6c757d',
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                cursor: 'pointer',
                fontSize: '15px',
                fontWeight: 'bold'
              }}
            >
              ← Back
            </button>

            <button
              type="button"
              onClick={handleCancelProblemCreation}
              style={{
                padding: '12px 24px',
                background: '#dc3545',
                color: 'white',
                border: 'none',
                borderRadius: '6px',
                cursor: 'pointer',
                fontSize: '15px',
                fontWeight: 'bold'
              }}
            >
              Cancel
            </button>
          </div>
        </form>
      )}

      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(350px, 1fr))',
        gap: '20px'
      }}>
        {problems.map((problem) => (
          <div
            key={problem.milestoneId}
            style={{
              background: 'white',
              border: '2px solid #dee2e6',
              borderRadius: '8px',
              padding: '20px',
              cursor: 'pointer',
              transition: 'all 0.3s ease',
              boxShadow: '0 2px 4px rgba(0,0,0,0.05)'
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.transform = 'translateY(-5px)';
              e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = 'translateY(0)';
              e.currentTarget.style.boxShadow = '0 2px 4px rgba(0,0,0,0.05)';
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: '10px' }}>
              <h3 style={{
                margin: 0,
                color: '#333',
                fontSize: '18px'
              }}>
                {problem.title}
              </h3>
              <span style={{
                background: getDifficultyColor(problem.difficulty),
                color: 'white',
                padding: '4px 10px',
                borderRadius: '4px',
                fontSize: '12px',
                fontWeight: 'bold',
                textTransform: 'capitalize'
              }}>
                {problem.difficulty}
              </span>
            </div>

            {problem.concept && (
              <p style={{
                color: '#007bff',
                fontSize: '14px',
                marginBottom: '15px',
                fontWeight: '500',
                fontStyle: 'italic'
              }}>
                📚 {problem.concept}
              </p>
            )}

            <div style={{
              display: 'flex',
              gap: '8px',
              marginBottom: '15px',
              flexWrap: 'wrap'
            }}>
              {problem.language && (
                <span style={{
                  background: '#e7f3ff',
                  color: '#0066cc',
                  padding: '4px 8px',
                  borderRadius: '4px',
                  fontSize: '12px',
                  fontWeight: 'bold'
                }}>
                  {problem.language.toUpperCase()}
                </span>
              )}
              {problem.testCaseCount !== undefined && (
                <span style={{
                  background: '#d4edda',
                  color: '#155724',
                  padding: '4px 8px',
                  borderRadius: '4px',
                  fontSize: '12px',
                  fontWeight: 'bold'
                }}>
                  📝 {problem.testCaseCount} test cases
                </span>
              )}
              {(() => {
                const isCompleted = userProfile?.completedMilestones?.some(
                  (m: any) => m.milestoneId === problem.milestoneId
                );
                const completedData = userProfile?.completedMilestones?.find(
                  (m: any) => m.milestoneId === problem.milestoneId
                );
                
                if (isCompleted && completedData) {
                  const passed = completedData.score === 100;
                  return (
                    <span style={{
                      background: passed ? '#28a745' : '#dc3545',
                      color: 'white',
                      padding: '4px 8px',
                      borderRadius: '4px',
                      fontSize: '12px',
                      fontWeight: 'bold'
                    }}>
                      {passed ? '✅' : '❌'} Submitted ({completedData.score}%)
                    </span>
                  );
                }
                return null;
              })()}
            </div>

            <div style={{
              display: 'flex',
              gap: '10px',
              justifyContent: 'space-between',
              alignItems: 'center',
              marginTop: '15px',
              paddingTop: '15px',
              borderTop: '1px solid #dee2e6'
            }}>
              <small style={{ color: '#999', fontSize: '12px' }}>
                Added: {new Date(problem.createdAt).toLocaleDateString()}
              </small>

              <div style={{ display: 'flex', gap: '10px' }}>
                {(() => {
                  const isCompleted = userProfile?.completedMilestones?.some(
                    (m: any) => m.milestoneId === problem.milestoneId
                  );
                  
                  return (
                    <button
                      onClick={() => handleOpenEditor(problem)}
                      style={{
                        padding: '8px 16px',
                        background: isCompleted ? '#6c757d' : '#007bff',
                        color: 'white',
                        border: 'none',
                        borderRadius: '4px',
                        cursor: 'pointer',
                        fontSize: '13px',
                        fontWeight: 'bold'
                      }}
                    >
                      {isCompleted ? 'View 📖' : 'Solve 💻'}
                    </button>
                  );
                })()}

                {isAdmin && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteProblem(problem.milestoneId);
                    }}
                    style={{
                      padding: '8px 16px',
                      background: '#dc3545',
                      color: 'white',
                      border: 'none',
                      borderRadius: '4px',
                      cursor: 'pointer',
                      fontSize: '13px',
                      fontWeight: 'bold'
                    }}
                  >
                    Delete
                  </button>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>

      {problems.length === 0 && !loading && (
        <div style={{
          textAlign: 'center',
          padding: '60px 20px',
          color: '#999'
        }}>
          <p style={{ fontSize: '18px', marginBottom: '10px' }}>📝 No problems available yet</p>
          <p style={{ fontSize: '14px' }}>
            {isAdmin ? 'Click "Add Problem" to create your first coding challenge!' : 'Check back later for new challenges!'}
          </p>
        </div>
      )}

      {showProctoringInstructions && pendingProblem && (
        <ProctoringInstructions
          problemTitle={pendingProblem.title}
          onProceed={handleProctoringGranted}
          onCancel={handleProctoringCancelled}
        />
      )}

      {selectedProblem && (
        <CodeEditor
          milestone={selectedProblem}
          userProfile={userProfile}
          webcamStream={webcamStream}
          screenStream={screenStream}
          onClose={handleCloseEditor}
          onSubmitSuccess={handleSubmitSuccess}
          isViewMode={!webcamStream && !screenStream} // View mode if no streams
        />
      )}
    </div>
  );
}