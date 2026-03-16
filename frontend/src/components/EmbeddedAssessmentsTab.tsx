import { useState, useEffect } from 'react';
import {
  getAllEmbeddedAssessments,
  createEmbeddedAssessment,
  deleteEmbeddedAssessment,
} from '../api/embedded-assessments';
import type { EmbeddedAssessment } from '../api/embedded-assessments';
import { ProctoringInstructions } from './proctoring/ProctoringInstructions';
import { EmbeddedEnvironment } from './EmbeddedEnvironment';

interface EmbeddedAssessmentsTabProps {
  userProfile: any;
  onRefreshNeeded?: () => void;
}

export function EmbeddedAssessmentsTab({ userProfile, onRefreshNeeded }: EmbeddedAssessmentsTabProps) {
  const isAdmin = userProfile?.role === 'admin';

  const [assessments, setAssessments] = useState<EmbeddedAssessment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [creationStep, setCreationStep] = useState<1 | 2>(1);

  // Proctoring state
  const [showProctoringInstructions, setShowProctoringInstructions] = useState(false);
  const [pendingAssessment, setPendingAssessment] = useState<EmbeddedAssessment | null>(null);
  const [selectedAssessment, setSelectedAssessment] = useState<EmbeddedAssessment | null>(null);
  const [webcamStream, setWebcamStream] = useState<MediaStream | null>(null);
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);

  // Step 1 form state
  const [newAssessment, setNewAssessment] = useState({
    title: '',
    description: '',
    difficulty: 'medium' as 'easy' | 'medium' | 'hard',
    bcdiplomaTemplateId: '',
  });

  // Step 2 rubric state
  const [rubric, setRubric] = useState<string[]>(['']);

  useEffect(() => {
    loadAssessments();
  }, []);

  async function loadAssessments() {
    try {
      setLoading(true);
      setError(null);
      const result = await getAllEmbeddedAssessments();
      setAssessments(result.assessments || []);
    } catch (err: any) {
      console.error('Failed to load embedded assessments:', err);
      setError('Failed to load embedded assessments');
    } finally {
      setLoading(false);
    }
  }

  // ==========================================
  // PROCTORING HANDLERS
  // ==========================================

  const handleStartAssessment = (assessment: EmbeddedAssessment) => {
    setPendingAssessment(assessment);
    setShowProctoringInstructions(true);
  };

  const handleProctoringGranted = (webcam: MediaStream, screen: MediaStream) => {
    setWebcamStream(webcam);
    setScreenStream(screen);
    setShowProctoringInstructions(false);
    if (pendingAssessment) {
      setSelectedAssessment(pendingAssessment);
    }
  };

  const handleProctoringCancelled = () => {
    setShowProctoringInstructions(false);
    setPendingAssessment(null);
  };

  const handleCloseEnvironment = async () => {
    if (webcamStream) {
      webcamStream.getTracks().forEach(track => track.stop());
      setWebcamStream(null);
    }
    if (screenStream) {
      screenStream.getTracks().forEach(track => track.stop());
      setScreenStream(null);
    }
    await loadAssessments();
    if (onRefreshNeeded) onRefreshNeeded();
    setSelectedAssessment(null);
    setPendingAssessment(null);
  };

  const handleSubmitSuccess = async () => {
    await loadAssessments();
    if (onRefreshNeeded) onRefreshNeeded();
  };

  // ==========================================
  // CREATION HANDLERS (Admin)
  // ==========================================

  const handleCreateAssessment = async () => {
    const validCriteria = rubric.filter(c => c.trim());

    if (!newAssessment.title.trim()) {
      setError('Title is required');
      return;
    }
    if (validCriteria.length === 0) {
      setError('At least one rubric criterion is required');
      return;
    }

    try {
      setError(null);
      await createEmbeddedAssessment({
        title: newAssessment.title,
        description: newAssessment.description,
        difficulty: newAssessment.difficulty,
        rubric: validCriteria,
        bcdiplomaTemplateId: newAssessment.bcdiplomaTemplateId || undefined,
      });
      await loadAssessments();
      handleCancelCreation();
    } catch (err: any) {
      console.error('Failed to create embedded assessment:', err);
      setError('Failed to create embedded assessment');
    }
  };

  const handleDeleteAssessment = async (assessmentId: string) => {
    if (!window.confirm('Are you sure you want to delete this assessment?')) return;
    try {
      setError(null);
      await deleteEmbeddedAssessment(assessmentId);
      setAssessments(assessments.filter(a => a.milestoneId !== assessmentId));
    } catch (err: any) {
      console.error('Failed to delete embedded assessment:', err);
      setError('Failed to delete assessment');
    }
  };

  const handleCancelCreation = () => {
    setIsCreating(false);
    setCreationStep(1);
    setNewAssessment({ title: '', description: '', difficulty: 'medium', bcdiplomaTemplateId: '' });
    setRubric(['']);
    setError(null);
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

  // ==========================================
  // RENDER
  // ==========================================

  if (showProctoringInstructions && pendingAssessment) {
    return (
      <ProctoringInstructions
        problemTitle={pendingAssessment.title}
        onProceed={handleProctoringGranted}
        onCancel={handleProctoringCancelled}
      />
    );
  }

  if (selectedAssessment) {
    return (
      <EmbeddedEnvironment
        assessment={selectedAssessment}
        onClose={handleCloseEnvironment}
        onSubmitSuccess={handleSubmitSuccess}
      />
    );
  }

  if (loading) {
    return <div style={{ textAlign: 'center', padding: '40px' }}><p>Loading embedded assessments...</p></div>;
  }

  return (
    <div style={{ padding: '20px' }}>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <div>
          <h2 style={{ marginBottom: '10px', color: '#333' }}>Embedded Systems Assessments</h2>
          <p style={{ color: '#666', margin: 0 }}>Total: <strong>{assessments.length}</strong></p>
        </div>
        {isAdmin && (
          <button
            onClick={() => isCreating ? handleCancelCreation() : setIsCreating(true)}
            style={{
              padding: '10px 20px', background: '#007bff', color: 'white',
              border: 'none', borderRadius: '4px', cursor: 'pointer',
              fontSize: '14px', fontWeight: 'bold'
            }}
          >
            {isCreating ? 'Cancel' : '➕ Create Assessment'}
          </button>
        )}
      </div>

      {error && (
        <div style={{
          background: '#f8d7da', color: '#721c24', padding: '15px',
          borderRadius: '8px', marginBottom: '20px', border: '1px solid #f5c6cb'
        }}>
          {error}
        </div>
      )}

      {/* Creation wizard */}
      {isAdmin && isCreating && (
        <div style={{
          background: '#f8f9fa', padding: '20px', borderRadius: '8px',
          marginBottom: '20px', border: '1px solid #dee2e6'
        }}>

          {/* Progress indicator */}
          <div style={{ display: 'flex', alignItems: 'center', gap: '20px', marginBottom: '24px' }}>
            {[
              { step: 1, label: 'Assessment Details' },
              { step: 2, label: 'Rubric Criteria' },
            ].map(({ step, label }, i) => (
              <div key={step} style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                {i > 0 && <div style={{ width: '40px', height: '2px', background: creationStep > i ? '#28a745' : '#ccc' }} />}
                <div style={{
                  width: '30px', height: '30px', borderRadius: '50%',
                  background: creationStep === step ? '#007bff' : creationStep > step ? '#28a745' : '#ccc',
                  color: 'white', display: 'flex', alignItems: 'center',
                  justifyContent: 'center', fontWeight: 'bold', fontSize: '14px'
                }}>
                  {creationStep > step ? '✓' : step}
                </div>
                <span style={{ color: '#333', fontWeight: creationStep === step ? 'bold' : 'normal' }}>{label}</span>
              </div>
            ))}
          </div>

          {/* Step 1: Details */}
          {creationStep === 1 && (
            <div>
              <h3 style={{ color: '#333', marginTop: 0 }}>Step 1: Assessment Details</h3>

              <div style={{ marginBottom: '15px' }}>
                <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '6px', color: '#333' }}>
                  Title *
                </label>
                <input
                  type="text"
                  value={newAssessment.title}
                  onChange={e => setNewAssessment({ ...newAssessment, title: e.target.value })}
                  placeholder="e.g. GPIO Button and LED Control"
                  style={{ width: '100%', padding: '10px', fontSize: '14px', border: '1px solid #ced4da', borderRadius: '4px', boxSizing: 'border-box' }}
                />
              </div>

              <div style={{ marginBottom: '15px' }}>
                <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '6px', color: '#333' }}>
                  Description
                </label>
                <textarea
                  value={newAssessment.description}
                  onChange={e => setNewAssessment({ ...newAssessment, description: e.target.value })}
                  placeholder="Describe what the student needs to implement..."
                  rows={4}
                  style={{ width: '100%', padding: '10px', fontSize: '14px', border: '1px solid #ced4da', borderRadius: '4px', boxSizing: 'border-box', fontFamily: 'inherit' }}
                />
              </div>

              <div style={{ marginBottom: '15px' }}>
                <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '6px', color: '#333' }}>
                  Difficulty
                </label>
                <select
                  value={newAssessment.difficulty}
                  onChange={e => setNewAssessment({ ...newAssessment, difficulty: e.target.value as any })}
                  style={{ padding: '10px', fontSize: '14px', border: '1px solid #ced4da', borderRadius: '4px' }}
                >
                  <option value="easy">Easy</option>
                  <option value="medium">Medium</option>
                  <option value="hard">Hard</option>
                </select>
              </div>

              <div style={{ marginBottom: '20px' }}>
                <label style={{ display: 'block', fontWeight: 'bold', marginBottom: '6px', color: '#333' }}>
                  BCdiploma Template ID
                </label>
                <input
                  type="text"
                  value={newAssessment.bcdiplomaTemplateId}
                  onChange={e => setNewAssessment({ ...newAssessment, bcdiplomaTemplateId: e.target.value })}
                  placeholder="e.g. 0x1234..."
                  style={{ width: '100%', padding: '10px', fontSize: '14px', border: '1px solid #ced4da', borderRadius: '4px', boxSizing: 'border-box' }}
                />
              </div>

              <button
                onClick={() => {
                  if (!newAssessment.title.trim()) { setError('Title is required'); return; }
                  setError(null);
                  setCreationStep(2);
                }}
                style={{
                  padding: '10px 24px', background: '#007bff', color: 'white',
                  border: 'none', borderRadius: '4px', cursor: 'pointer',
                  fontSize: '14px', fontWeight: 'bold'
                }}
              >
                Next: Add Rubric →
              </button>
            </div>
          )}

          {/* Step 2: Rubric */}
          {creationStep === 2 && (
            <div>
              <h3 style={{ color: '#333', marginTop: 0 }}>Step 2: Rubric Criteria</h3>
              <p style={{ color: '#666', fontSize: '14px', marginBottom: '16px' }}>
                Each criterion is one thing Claude will check in the student's code.
                Be specific — e.g. "LEFT_BUTTON is defined as bit 1 using a bitmask" not just "correct definitions".
              </p>

              {rubric.map((criterion, index) => (
                <div key={index} style={{ display: 'flex', gap: '8px', marginBottom: '10px', alignItems: 'center' }}>
                  <span style={{ color: '#666', fontSize: '14px', minWidth: '24px' }}>{index + 1}.</span>
                  <input
                    type="text"
                    value={criterion}
                    onChange={e => handleCriterionChange(index, e.target.value)}
                    placeholder="e.g. P1DIR is configured to make LED an output using |= operator"
                    style={{
                      flex: 1, padding: '10px', fontSize: '14px',
                      border: '1px solid #ced4da', borderRadius: '4px'
                    }}
                  />
                  <button
                    onClick={() => handleRemoveCriterion(index)}
                    disabled={rubric.length === 1}
                    style={{
                      padding: '8px 12px', background: rubric.length === 1 ? '#dee2e6' : '#dc3545',
                      color: rubric.length === 1 ? '#999' : 'white',
                      border: 'none', borderRadius: '4px',
                      cursor: rubric.length === 1 ? 'not-allowed' : 'pointer'
                    }}
                  >
                    ✕
                  </button>
                </div>
              ))}

              <button
                onClick={handleAddCriterion}
                style={{
                  padding: '8px 16px', background: 'transparent', color: '#007bff',
                  border: '1px dashed #007bff', borderRadius: '4px',
                  cursor: 'pointer', fontSize: '14px', marginBottom: '20px'
                }}
              >
                + Add Criterion
              </button>

              <div style={{ display: 'flex', gap: '10px' }}>
                <button
                  onClick={() => setCreationStep(1)}
                  style={{
                    padding: '10px 20px', background: '#6c757d', color: 'white',
                    border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '14px'
                  }}
                >
                  ← Back
                </button>
                <button
                  onClick={handleCreateAssessment}
                  style={{
                    padding: '10px 24px', background: '#28a745', color: 'white',
                    border: 'none', borderRadius: '4px', cursor: 'pointer',
                    fontSize: '14px', fontWeight: 'bold'
                  }}
                >
                  ✓ Create Assessment
                </button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Assessment list */}
      {assessments.length === 0 ? (
        <div style={{
          textAlign: 'center', padding: '40px', background: '#f8f9fa',
          borderRadius: '8px', color: '#666'
        }}>
          <p>No embedded assessments available yet.</p>
          {isAdmin && <p>Click "Create Assessment" to add one.</p>}
        </div>
      ) : (
        <div style={{ display: 'grid', gap: '15px' }}>
          {assessments.map(assessment => (
            <div
              key={assessment.milestoneId}
              style={{
                background: '#fff', padding: '20px', borderRadius: '8px',
                border: '1px solid #dee2e6', boxShadow: '0 2px 4px rgba(0,0,0,0.05)'
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div style={{ flex: 1 }}>
                  <h3 style={{ color: '#333', margin: '0 0 8px 0' }}>{assessment.title}</h3>
                  {assessment.description && (
                    <p style={{ color: '#666', margin: '0 0 10px 0', fontSize: '14px' }}>{assessment.description}</p>
                  )}
                  <div style={{ display: 'flex', gap: '16px', color: '#666', fontSize: '13px' }}>
                    <span>🎯 {assessment.difficulty}</span>
                    <span>📋 {assessment.rubric.length} criteria</span>
                    <span style={{
                      background: '#e7f3ff', color: '#0066cc',
                      padding: '2px 8px', borderRadius: '4px', fontSize: '12px'
                    }}>
                      Embedded Systems
                    </span>
                  </div>
                </div>
                <div style={{ display: 'flex', gap: '10px', flexShrink: 0, marginLeft: '16px' }}>
                  <button
                    onClick={() => handleStartAssessment(assessment)}
                    style={{
                      padding: '10px 20px', background: '#007bff', color: 'white',
                      border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '14px'
                    }}
                  >
                    {isAdmin ? 'Preview' : 'Start'}
                  </button>
                  {isAdmin && (
                    <button
                      onClick={() => handleDeleteAssessment(assessment.milestoneId)}
                      style={{
                        padding: '10px 16px', background: '#dc3545', color: 'white',
                        border: 'none', borderRadius: '4px', cursor: 'pointer', fontSize: '14px'
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
      )}
    </div>
  );
}