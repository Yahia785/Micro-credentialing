import { useId, useState } from 'react';
import { createEmbeddedAssessment } from '../../api/embedded-assessments';
import { storedCourse } from '../../api/assessments';
import { createMilestone, deleteMilestone } from '../../api/milestones';
import { createTestCasesBatch } from '../../api/testcases';
import type { AssessmentKind } from '../../types/assessment';
import { classNames } from '../../utils/classNames';
import { DIFFICULTIES, getDifficultyLabel } from '../../utils/difficulty';
import type { Difficulty } from '../../utils/difficulty';
import { Alert, Button, Card, FormField, Input, Select, Textarea } from '../ui';
import styles from './AssessmentCreateForm.module.css';

interface TestCaseInput {
  inputs: string[];
  expectedOutput: string;
  isHidden: boolean;
}

interface AssessmentCreateFormProps {
  /** Existing course names, offered as suggestions. */
  courseSuggestions: string[];
  /** Called after the assessment (and its test cases / rubric) has been saved. */
  onCreated: (warning?: string) => Promise<void>;
  onCancel: () => void;
}

const INITIAL_PROBLEM = {
  title: '',
  description: '',
  concept: '',
  difficulty: 'medium' as Difficulty,
  language: 'cpp',
  starterCode: '',
  timeLimit: 5000,
  memoryLimit: 256000,
  bcdiplomaTemplateId: '',
};

const INITIAL_EMBEDDED = {
  title: '',
  description: '',
  difficulty: 'medium' as Difficulty,
  bcdiplomaTemplateId: '',
};

const newTestCase = (): TestCaseInput => ({ inputs: ['', ''], expectedOutput: '', isHidden: false });

export function AssessmentCreateForm({ courseSuggestions, onCreated, onCancel }: AssessmentCreateFormProps) {
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [course, setCourse] = useState('');
  const [kind, setKind] = useState<AssessmentKind>('coding');
  const [error, setError] = useState<string | null>(null);
  const courseListId = useId();

  // Coding problem state
  const [newProblem, setNewProblem] = useState(INITIAL_PROBLEM);
  const [testCases, setTestCases] = useState<TestCaseInput[]>([newTestCase()]);
  // Guards the final step so a double click can't create the assessment twice.
  const [submitting, setSubmitting] = useState(false);

  // Embedded assessment state
  const [newAssessment, setNewAssessment] = useState(INITIAL_EMBEDDED);
  const [rubric, setRubric] = useState<string[]>(['']);

  const courseValue = course.replace(/\s+/g, ' ').trim();
  const stepLabels = ['Course and type', 'Details', kind === 'coding' ? 'Test cases' : 'Rubric'];

  const COURSE_NOT_SAVED_WARNING =
    'The assessment was created, but the server did not save its course. The backend may be out of date; use "Change course" once it is updated.';

  // ---------- Step 1: course and type ----------
  const handleChooseTypeNext = (e: React.FormEvent) => {
    e.preventDefault();
    if (/[<>]/.test(courseValue)) {
      setError('The course must be plain text (no < or > characters).');
      return;
    }
    setError(null);
    setStep(2);
  };

  // ---------- Coding problem (existing logic) ----------
  const handleAddProblem = (e: React.FormEvent) => {
    e.preventDefault();

    if (!newProblem.title.trim() || !newProblem.description.trim()) {
      setError('Title and description are required');
      return;
    }

    // Nothing is saved yet: going Back and forward just edits this draft.
    setError(null);
    setStep(3);
  };

  const handleAddTestCases = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;

    const validTestCases = testCases.filter((tc) => {
      const hasInputs = tc.inputs.some((input) => input.trim() !== '');
      const hasOutput = tc.expectedOutput.trim() !== '';
      return hasInputs && hasOutput;
    });

    if (validTestCases.length === 0) {
      setError('At least one test case with inputs and expected output is required');
      return;
    }

    const testCasesToCreate = validTestCases.map((tc, index) => {
      const inputString = tc.inputs.filter((input) => input.trim() !== '').join('\n');

      return {
        input: inputString,
        expectedOutput: tc.expectedOutput,
        isHidden: tc.isHidden,
        includeInJudge0: true,
        weight: 1,
        order: index,
        testTier: 'standard',
      };
    });

    setSubmitting(true);
    setError(null);

    let createdId: string | null = null;
    let warning: string | undefined;
    try {
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
        bcdiplomaTemplateId: newProblem.bcdiplomaTemplateId || undefined,
        course: courseValue || undefined,
      });
      const newProblemId: string = result.milestone.milestoneId;
      createdId = newProblemId;
      if (courseValue && storedCourse(result.milestone) !== courseValue) warning = COURSE_NOT_SAVED_WARNING;

      console.log('Creating test cases for problem:', newProblemId, testCasesToCreate);
      await createTestCasesBatch(newProblemId, testCasesToCreate);
    } catch (err) {
      console.error('Failed to create problem:', err);
      if (createdId) {
        // Don't leave a problem without test cases behind.
        try {
          await deleteMilestone(createdId);
        } catch (cleanupErr) {
          console.error('Could not remove the unfinished problem:', createdId, cleanupErr);
        }
      }
      setError('Failed to create problem. Please try again.');
      setSubmitting(false);
      return;
    }

    await onCreated(warning);
    setSubmitting(false);
  };

  const handleAddTestCaseRow = () => {
    setTestCases([...testCases, newTestCase()]);
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

  const getTestCaseStats = () => {
    const counted = testCases.filter((tc) => {
      const hasInputs = tc.inputs.some((input) => input.trim() !== '');
      const hasOutput = tc.expectedOutput.trim() !== '';
      return hasInputs && hasOutput;
    });
    const visible = counted.filter((tc) => !tc.isHidden).length;
    const hidden = counted.filter((tc) => tc.isHidden).length;
    return { visible, hidden, total: visible + hidden };
  };

  // ---------- Embedded assessment (existing logic) ----------
  const handleEmbeddedDetailsNext = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newAssessment.title.trim()) {
      setError('Title is required');
      return;
    }
    setError(null);
    setStep(3);
  };

  const handleCreateEmbedded = async (e: React.FormEvent) => {
    e.preventDefault();
    if (submitting) return;
    const validCriteria = rubric.filter((c) => c.trim());
    if (!newAssessment.title.trim()) {
      setError('Title is required');
      return;
    }
    if (validCriteria.length === 0) {
      setError('At least one rubric criterion is required');
      return;
    }

    setSubmitting(true);
    setError(null);

    let warning: string | undefined;
    try {
      const result = await createEmbeddedAssessment({
        title: newAssessment.title,
        description: newAssessment.description,
        difficulty: newAssessment.difficulty,
        rubric: validCriteria,
        bcdiplomaTemplateId: newAssessment.bcdiplomaTemplateId || undefined,
        course: courseValue || undefined,
      });
      if (courseValue && storedCourse(result.assessment) !== courseValue) warning = COURSE_NOT_SAVED_WARNING;
    } catch (err) {
      console.error('Failed to create embedded assessment:', err);
      setError('Failed to create embedded assessment');
      setSubmitting(false);
      return;
    }

    await onCreated(warning);
    setSubmitting(false);
  };

  const handleAddCriterion = () => setRubric([...rubric, '']);
  const handleRemoveCriterion = (index: number) => {
    if (rubric.length > 1) setRubric(rubric.filter((_, i) => i !== index));
  };
  const handleCriterionChange = (index: number, value: string) => {
    const updated = [...rubric];
    updated[index] = value;
    setRubric(updated);
  };

  const goBack = () => {
    setError(null);
    setStep((current) => (current === 3 ? 2 : 1));
  };

  const difficultyOptions = DIFFICULTIES.map((difficulty) => (
    <option key={difficulty} value={difficulty}>
      {getDifficultyLabel(difficulty)}
    </option>
  ));

  return (
    <div className={styles.wrapper}>
      <ol className={styles.steps} aria-label="Assessment creation steps">
        {stepLabels.map((label, index) => {
          const number = index + 1;
          const state = number === step ? styles.stepCurrent : number < step ? styles.stepDone : styles.stepPending;
          return (
            <li
              key={label}
              className={classNames(styles.step, state)}
              aria-current={number === step ? 'step' : undefined}
            >
              <span className={styles.stepMarker} aria-hidden="true">
                {number < step ? '✓' : number}
              </span>
              <span className={styles.stepLabel}>{label}</span>
            </li>
          );
        })}
      </ol>

      {error && <Alert variant="danger">{error}</Alert>}

      {step === 1 && (
        <Card title="Step 1: Course and type" headingLevel={2}>
          <form onSubmit={handleChooseTypeNext} className={styles.form}>
            <FormField
              label="Course"
              hint="Optional. Pick an existing course or type a new one. Leave empty for “No course”."
            >
              <Input
                type="text"
                list={courseListId}
                value={course}
                onChange={(e) => setCourse(e.target.value)}
                placeholder="e.g., ECE 3430"
                maxLength={80}
              />
            </FormField>
            <datalist id={courseListId}>
              {courseSuggestions.map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>

            <FormField label="Type" required hint="The type decides what you set up next: test cases or rubric criteria.">
              <Select value={kind} onChange={(e) => setKind(e.target.value as AssessmentKind)}>
                <option value="coding">C++ coding problem (graded with test cases)</option>
                <option value="embedded">Embedded C assessment (graded with a rubric)</option>
              </Select>
            </FormField>

            <div className={styles.formActions}>
              <Button type="submit">Next: details</Button>
              <Button variant="secondary" onClick={onCancel}>
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      )}

      {step === 2 && kind === 'coding' && (
        <Card title="Step 2: Problem details" headingLevel={2}>
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
                  onChange={(e) => setNewProblem({ ...newProblem, difficulty: e.target.value as Difficulty })}
                >
                  {difficultyOptions}
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
                  <option value="cpp">C++</option>
                  <option value="c">C</option>
                  <option value="python">Python</option>
                  <option value="javascript">JavaScript</option>
                  <option value="java">Java</option>
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
              <Button variant="secondary" onClick={goBack}>
                Back
              </Button>
              <Button variant="secondary" onClick={onCancel}>
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      )}

      {step === 3 && kind === 'coding' && (
        <Card title="Step 3: Add test cases" headingLevel={2}>
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
              <Button type="submit" loading={submitting}>
                {submitting ? 'Creating…' : 'Complete assessment creation'}
              </Button>
              <Button variant="secondary" onClick={goBack}>
                Back
              </Button>
              <Button variant="secondary" onClick={onCancel}>
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      )}

      {step === 2 && kind === 'embedded' && (
        <Card title="Step 2: Assessment details" headingLevel={2}>
          <form onSubmit={handleEmbeddedDetailsNext} className={styles.form}>
            <FormField label="Title" required>
              <Input
                type="text"
                value={newAssessment.title}
                onChange={(e) => setNewAssessment({ ...newAssessment, title: e.target.value })}
                placeholder="e.g. GPIO Button and LED Control"
              />
            </FormField>

            <FormField label="Description">
              <Textarea
                className={styles.tall}
                value={newAssessment.description}
                onChange={(e) => setNewAssessment({ ...newAssessment, description: e.target.value })}
                placeholder="Describe what the student needs to implement..."
                rows={4}
              />
            </FormField>

            <FormField label="Difficulty">
              <Select
                value={newAssessment.difficulty}
                onChange={(e) => setNewAssessment({ ...newAssessment, difficulty: e.target.value as Difficulty })}
              >
                {difficultyOptions}
              </Select>
            </FormField>

            <FormField label="BCdiploma template ID">
              <Input
                type="text"
                value={newAssessment.bcdiplomaTemplateId}
                onChange={(e) => setNewAssessment({ ...newAssessment, bcdiplomaTemplateId: e.target.value })}
                placeholder="e.g. 0x1234..."
              />
            </FormField>

            <div className={styles.formActions}>
              <Button type="submit">Next: add rubric</Button>
              <Button variant="secondary" onClick={goBack}>
                Back
              </Button>
              <Button variant="secondary" onClick={onCancel}>
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      )}

      {step === 3 && kind === 'embedded' && (
        <Card title="Step 3: Add rubric criteria" headingLevel={2}>
          <form onSubmit={handleCreateEmbedded} className={styles.form}>
            <p className={styles.intro}>
              Each criterion is one thing that will be checked in the student's code. Be specific.
            </p>

            {rubric.map((criterion, index) => (
              <div key={index} className={styles.inputRow}>
                <FormField className={styles.grow} label={`Criterion ${index + 1}`}>
                  <Input
                    type="text"
                    value={criterion}
                    onChange={(e) => handleCriterionChange(index, e.target.value)}
                    placeholder="e.g. P1DIR is configured to make LED an output using |= operator"
                  />
                </FormField>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => handleRemoveCriterion(index)}
                  disabled={rubric.length === 1}
                  aria-label={`Remove criterion ${index + 1}`}
                >
                  Remove
                </Button>
              </div>
            ))}

            <div>
              <Button variant="secondary" size="sm" onClick={handleAddCriterion}>
                Add criterion
              </Button>
            </div>

            <div className={styles.formActions}>
              <Button type="submit" loading={submitting}>
                {submitting ? 'Creating…' : 'Create assessment'}
              </Button>
              <Button variant="secondary" onClick={goBack}>
                Back
              </Button>
              <Button variant="secondary" onClick={onCancel}>
                Cancel
              </Button>
            </div>
          </form>
        </Card>
      )}
    </div>
  );
}
