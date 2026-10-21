import { useState, useEffect, useRef } from 'react';
import { getAllMilestones, createMilestone, deleteMilestone } from '../api/milestones';
import { createTestCasesBatch } from '../api/testcases';
import { CodeEditor } from './CodeEditor';
import type { CodeEditorHandle } from './CodeEditor';
import {
  Alert,
  Badge,
  BlockingOverlay,
  Button,
  Card,
  DifficultyBadge,
  EmptyState,
  FormField,
  Input,
  Select,
  Spinner,
  StatusBadge,
  Textarea,
} from './ui';
import { classNames } from '../utils/classNames';
import { DIFFICULTIES, getDifficultyLabel } from '../utils/difficulty';
import styles from './ProblemsTab.module.css';
import { ProctoringInstructions } from './proctoring/ProctoringInstructions';
import { useUser } from '../context/UserContext';
import { useAssessmentNavigationGuard } from '../hooks/useAssessmentNavigationGuard';
import { useStopStreamsOnUnmount } from '../hooks/useStopStreamsOnUnmount';

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

export function ProblemsTab() {
  const { userProfile, refreshProfile } = useUser();
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
  // True once the editor's own submission has fully finished; nothing is left to lose by leaving.
  const [submissionSettled, setSubmissionSettled] = useState(false);

  // A proctored session is live while the editor is open with streams and nothing has been submitted yet.
  const isProctoredSessionActive = Boolean(
    selectedProblem &&
      (webcamStream || screenStream) &&
      !submissionSettled &&
      !userProfile?.completedMilestones?.some((m) => m.milestoneId === selectedProblem.milestoneId)
  );
  const editorRef = useRef<CodeEditorHandle>(null);
  // Leaving mid-session counts as submitting the current code.
  const { isSubmitting: isSubmittingOnLeave } = useAssessmentNavigationGuard(
    isProctoredSessionActive,
    async () => (await editorRef.current?.submitAndEnd('left_page')) ?? { ok: true },
    // Otherwise the list still shows the problem as not attempted after leaving.
    refreshProfile
  );
  useStopStreamsOnUnmount(webcamStream, screenStream);

  const [newProblem, setNewProblem] = useState({
    title: '',
    description: '',
    concept: '',
    difficulty: 'medium' as Problem['difficulty'],
    language: 'python',
    starterCode: '',
    timeLimit: 5000,
    memoryLimit: 256000,
    bcdiplomaTemplateId: ''
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
        memoryLimit: newProblem.memoryLimit,
        bcdiplomaTemplateId: newProblem.bcdiplomaTemplateId || undefined
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
        memoryLimit: 256000,
        bcdiplomaTemplateId: ''
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
      memoryLimit: 256000,
      bcdiplomaTemplateId: ''
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
      (m) => m.milestoneId === problem.milestoneId
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
    setSubmissionSettled(false);
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
    console.log('🔄 Triggering user profile refresh...');
    await refreshProfile();
    
    setSubmissionSettled(false);
    setSelectedProblem(null);
    setPendingProblem(null);
  };

const handleSubmitSuccess = async () => {
    console.log('🎉 Submission successful, reloading data...');
    await loadProblems();
    
    // Trigger user profile refresh in parent component
    await refreshProfile();
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
      <div className={styles.loading}>
        <Spinner decorative />
        <p className={styles.loadingText} role="status">
          Loading problems…
        </p>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      <div className={styles.toolbar}>
        <p className={styles.count}>
          Total problems: <strong>{problems.length}</strong>
        </p>
        {isAdmin && (
          <Button
            variant={isAddingProblem ? 'secondary' : 'primary'}
            onClick={() => {
              setIsAddingProblem(!isAddingProblem);
              setError(null);
              if (isAddingProblem) {
                handleCancelProblemCreation();
              }
            }}
          >
            {isAddingProblem ? 'Cancel' : 'Add problem'}
          </Button>
        )}
      </div>

      {error && <Alert variant="danger">{error}</Alert>}

      {isAdmin && isAddingProblem && (
        <ol className={styles.steps} aria-label="Problem creation steps">
          <li
            className={classNames(styles.step, creationStep === 1 ? styles.stepCurrent : styles.stepDone)}
            aria-current={creationStep === 1 ? 'step' : undefined}
          >
            <span className={styles.stepMarker} aria-hidden="true">
              {creationStep === 1 ? '1' : '✓'}
            </span>
            <span className={styles.stepLabel}>Problem details</span>
          </li>
          <li className={styles.stepDivider} aria-hidden="true" />
          <li
            className={classNames(styles.step, creationStep === 2 ? styles.stepCurrent : styles.stepPending)}
            aria-current={creationStep === 2 ? 'step' : undefined}
          >
            <span className={styles.stepMarker} aria-hidden="true">
              2
            </span>
            <span className={styles.stepLabel}>Add test cases</span>
          </li>
        </ol>
      )}

      {isAdmin && isAddingProblem && creationStep === 1 && (
        <Card title="Step 1: Create new problem" headingLevel={2}>
          <form onSubmit={handleAddProblem} className={styles.form}>
            <FormField label="Problem title" required>
              <Input
                type="text"
                value={newProblem.title}
                onChange={(e) => setNewProblem({ ...newProblem, title: e.target.value })}
                placeholder="e.g., Two Sum"
                required
              />
            </FormField>

            <FormField label="Concept / topic" hint="This will be shown to users before they start solving.">
              <Input
                type="text"
                value={newProblem.concept}
                onChange={(e) => setNewProblem({ ...newProblem, concept: e.target.value })}
                placeholder="e.g., Arrays, Linked Lists, Dynamic Programming"
              />
            </FormField>

            <FormField
              label="BCdiploma template ID"
              hint="The template ID from your BCdiploma account for this problem's certificate."
            >
              <Input
                type="text"
                value={newProblem.bcdiplomaTemplateId}
                onChange={(e) => setNewProblem({ ...newProblem, bcdiplomaTemplateId: e.target.value })}
                placeholder="e.g., 0x13"
              />
            </FormField>

            <FormField label="Description" required hint="This will be hidden until the user opens the code editor.">
              <Textarea
                className={styles.tall}
                value={newProblem.description}
                onChange={(e) => setNewProblem({ ...newProblem, description: e.target.value })}
                placeholder="Describe the problem in detail..."
                required
              />
            </FormField>

            <div className={styles.pair}>
              <FormField label="Difficulty">
                <Select
                  value={newProblem.difficulty}
                  onChange={(e) => setNewProblem({ ...newProblem, difficulty: e.target.value as Problem['difficulty'] })}
                >
                  {DIFFICULTIES.map((difficulty) => (
                    <option key={difficulty} value={difficulty}>
                      {getDifficultyLabel(difficulty)}
                    </option>
                  ))}
                </Select>
              </FormField>

              <FormField label="Language" required>
                <Select
                  value={newProblem.language}
                  onChange={(e) => {
                    console.log('Language changed to:', e.target.value);
                    setNewProblem({ ...newProblem, language: e.target.value });
                  }}
                >
                  <option value="python">Python</option>
                  <option value="javascript">JavaScript</option>
                  <option value="java">Java</option>
                  <option value="cpp">C++</option>
                  <option value="c">C</option>
                </Select>
              </FormField>
            </div>

            <FormField label="Starter code (optional)" hint="Leave empty to use the default template.">
              <Textarea
                className={classNames(styles.tall, styles.mono)}
                value={newProblem.starterCode}
                onChange={(e) => setNewProblem({ ...newProblem, starterCode: e.target.value })}
                placeholder="Leave empty for default template..."
              />
            </FormField>

            <div className={styles.pair}>
              <FormField label="Time limit (ms)">
                <Input
                  type="number"
                  value={newProblem.timeLimit}
                  onChange={(e) => setNewProblem({ ...newProblem, timeLimit: parseInt(e.target.value) || 5000 })}
                />
              </FormField>

              <FormField label="Memory limit (KB)">
                <Input
                  type="number"
                  value={newProblem.memoryLimit}
                  onChange={(e) => setNewProblem({ ...newProblem, memoryLimit: parseInt(e.target.value) || 256000 })}
                />
              </FormField>
            </div>

            <div className={styles.formActions}>
              <Button type="submit">Next: add test cases</Button>
              <Button variant="secondary" onClick={handleCancelProblemCreation}>
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      )}

      {isAdmin && isAddingProblem && creationStep === 2 && (
        <Card title="Step 2: Add test cases" headingLevel={2}>
          <form onSubmit={handleAddTestCases} className={styles.form}>
            <Alert variant="info" title="Test cases summary">
              {getTestCaseStats().total} total ({getTestCaseStats().visible} sample, {getTestCaseStats().hidden} hidden)
            </Alert>

            {testCases.map((testCase, testCaseIndex) => (
              <Card
                key={testCaseIndex}
                title={`Test case ${testCaseIndex + 1}`}
                headingLevel={3}
                actions={
                  testCases.length > 1 ? (
                    <Button variant="danger" size="sm" onClick={() => handleRemoveTestCase(testCaseIndex)}>
                      Remove test case
                    </Button>
                  ) : undefined
                }
              >
                <div className={styles.form}>
                  <fieldset className={styles.inputs}>
                    <legend className={styles.legend}>Inputs</legend>

                    <div className={styles.inputGrid}>
                      {testCase.inputs.map((input, inputIndex) => (
                        <div key={inputIndex} className={styles.inputRow}>
                          <FormField className={styles.grow} label={`Input ${inputIndex + 1}`}>
                            <Input
                              className={styles.mono}
                              type="text"
                              value={input}
                              onChange={(e) => handleInputChange(testCaseIndex, inputIndex, e.target.value)}
                              placeholder={`Value ${inputIndex + 1}`}
                            />
                          </FormField>
                          {testCase.inputs.length > 1 && (
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => handleRemoveInputField(testCaseIndex, inputIndex)}
                              aria-label={`Remove input ${inputIndex + 1}`}
                              title="Remove this input"
                            >
                              Remove
                            </Button>
                          )}
                        </div>
                      ))}
                    </div>

                    <div>
                      <Button variant="secondary" size="sm" onClick={() => handleAddInputField(testCaseIndex)}>
                        Add input field
                      </Button>
                    </div>
                  </fieldset>

                  <FormField label="Expected output" required>
                    <Textarea
                      className={styles.mono}
                      value={testCase.expectedOutput}
                      onChange={(e) => handleOutputChange(testCaseIndex, e.target.value)}
                      placeholder="e.g., 5"
                      required
                    />
                  </FormField>

                  <label className={styles.checkLabel}>
                    <input
                      type="checkbox"
                      checked={testCase.isHidden}
                      onChange={(e) => handleHiddenChange(testCaseIndex, e.target.checked)}
                    />
                    <span>{testCase.isHidden ? 'Hidden (for grading only)' : 'Sample (visible to users)'}</span>
                  </label>
                </div>
              </Card>
            ))}

            <Button variant="secondary" className={styles.fullWidth} onClick={handleAddTestCaseRow}>
              Add another test case
            </Button>

            <div className={styles.formActions}>
              <Button type="submit">Complete problem creation</Button>
              <Button variant="secondary" onClick={handleBackToStep1}>
                Back
              </Button>
              <Button variant="secondary" onClick={handleCancelProblemCreation}>
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      )}

      <div className={styles.grid}>
        {problems.map((problem) => {
          const isCompleted = userProfile?.completedMilestones?.some(
            (m) => m.milestoneId === problem.milestoneId
          );
          const completedData = userProfile?.completedMilestones?.find(
            (m) => m.milestoneId === problem.milestoneId
          );

          return (
            <Card
              key={problem.milestoneId}
              interactive
              headingLevel={2}
              title={problem.title}
              actions={<DifficultyBadge difficulty={problem.difficulty} />}
              footer={
                <>
                  <small className={styles.added}>Added: {new Date(problem.createdAt).toLocaleDateString()}</small>

                  <div className={styles.actions}>
                    <Button
                      size="sm"
                      variant={isCompleted ? 'secondary' : 'primary'}
                      onClick={() => handleOpenEditor(problem)}
                    >
                      {isCompleted ? 'View submission' : 'Solve problem'}
                    </Button>

                    {isAdmin && (
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDeleteProblem(problem.milestoneId);
                        }}
                      >
                        Delete
                      </Button>
                    )}
                  </div>
                </>
              }
            >
              {problem.concept && <p className={styles.concept}>{problem.concept}</p>}

              <div className={styles.tags}>
                {problem.language && <Badge variant="info">{problem.language.toUpperCase()}</Badge>}
                {problem.testCaseCount !== undefined && (
                  <Badge variant="neutral">{problem.testCaseCount} test cases</Badge>
                )}
                {(() => {
                  // Never graded (grading was unavailable): under review, not a score.
                  const reviewStatus = completedData?.proctoringData?.reviewStatus;
                  if (completedData?.gradingFailed && reviewStatus !== 'approved' && reviewStatus !== 'rejected') {
                    return <StatusBadge status="pending" />;
                  }

                  if (isCompleted && completedData) {
                    const passed = completedData.score === 100;
                    return (
                      <Badge variant={passed ? 'success' : 'danger'}>Submitted ({completedData.score}%)</Badge>
                    );
                  }
                  return null;
                })()}
              </div>
            </Card>
          );
        })}
      </div>

      {problems.length === 0 && !loading && (
        <EmptyState
          headingLevel={2}
          title="No problems available yet"
          description={
            isAdmin
              ? 'Select "Add problem" to create your first coding challenge.'
              : 'Check back later for new challenges.'
          }
        />
      )}

      {showProctoringInstructions && pendingProblem && (
        <ProctoringInstructions
          problemTitle={pendingProblem.title}
          onProceed={handleProctoringGranted}
          onCancel={handleProctoringCancelled}
        />
      )}

      {isSubmittingOnLeave && (
        <BlockingOverlay message="Submitting your work…" detail="Please keep this tab open." />
      )}

      {selectedProblem && (
        <CodeEditor
          ref={editorRef}
          onSubmitSettled={() => setSubmissionSettled(true)}
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
