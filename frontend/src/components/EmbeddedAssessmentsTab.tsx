import { useState, useEffect } from 'react';
import {
  getAllEmbeddedAssessments,
  createEmbeddedAssessment,
  deleteEmbeddedAssessment,
} from '../api/embedded-assessments';
import type { EmbeddedAssessment } from '../api/embedded-assessments';
import { ProctoringInstructions } from './proctoring/ProctoringInstructions';
//import { EmbeddedEnvironment } from './EmbeddedEnvironment';
import { CodeEditor } from './CodeEditor';
import { getAuthToken, API_BASE } from '../api/config';


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

  const [selectedAssessment, setSelectedAssessment] = useState<EmbeddedAssessment | null>(null);
  const [pendingAssessment, setPendingAssessment] = useState<EmbeddedAssessment | null>(null);
  const [showProctoringInstructions, setShowProctoringInstructions] = useState(false);
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

  // Submission review statuses fetched from the Submissions table (source of truth)
  const [submissionStatus, setSubmissionStatus] = useState<{[key: string]: string}>({});

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

  // Fetch actual review statuses from the Submissions table
  // This is the source of truth — completedMilestones on the Users table
  // does not reliably have reviewStatus written to it
  useEffect(() => {
    const loadSubmissionStatuses = async () => {
      try {
        const token = await getAuthToken();
        const statuses: {[key: string]: string} = {};
        
        for (const assessment of assessments) {
          const isCompleted = userProfile?.completedMilestones?.some(
            (m: any) => m.milestoneId === assessment.milestoneId
          );
          
          if (isCompleted) {
            const completedData = userProfile?.completedMilestones?.find(
              (m: any) => m.milestoneId === assessment.milestoneId
            );
            
            if (completedData?.submissionId) {
              const response = await fetch(`${API_BASE}/submissions/${completedData.submissionId}`, {
                headers: { 'Authorization': `Bearer ${token}` }
              });
              
              if (response.ok) {
                const data = await response.json();
                statuses[assessment.milestoneId] = data.submission?.proctoringData?.reviewStatus || 'pending';
              }
            }
          }
        }
        
        setSubmissionStatus(statuses);
      } catch (err) {
        console.error('Failed to load submission statuses:', err);
      }
    };
    
    loadSubmissionStatuses();
  }, [assessments, userProfile]);

  const getDifficultyColor = (difficulty: string) => {
    switch (difficulty) {
      case 'easy': return '#28a745';
      case 'medium': return '#ffc107';
      case 'hard': return '#dc3545';
      default: return '#6c757d';
    }
  };

  // ==========================================
  // OPEN / PROCTORING HANDLERS
  // ==========================================

  const handleOpenEditor = (assessment: EmbeddedAssessment) => {
    const isCompleted = userProfile?.completedMilestones?.some(
      (m: any) => m.milestoneId === assessment.milestoneId
    );

    if (isCompleted) {
      // Skip proctoring for completed — open in view mode directly
      setSelectedAssessment(assessment);
      setWebcamStream(null);
      setScreenStream(null);
    } else {
      setPendingAssessment(assessment);
      setShowProctoringInstructions(true);
    }
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

  const handleCloseEditor = async () => {
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

  const handleCancelCreation = () => {
    setIsCreating(false);
    setCreationStep(1);
    setNewAssessment({ title: '', description: '', difficulty: 'medium', bcdiplomaTemplateId: '' });
    setRubric(['']);
    setError(null);
  };

  const handleCreateAssessment = async () => {
    const validCriteria = rubric.filter(c => c.trim());
    if (!newAssessment.title.trim()) { setError('Title is required'); return; }
    if (validCriteria.length === 0) { setError('At least one rubric criterion is required'); return; }

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

  const handleDeleteAssessment = async (milestoneId: string) => {
    if (!window.confirm('Are you sure you want to delete this problem?')) return;
    try {
      setError(null);
      await deleteEmbeddedAssessment(milestoneId);
      setAssessments(assessments.filter(a => a.milestoneId !== milestoneId));
    } catch (err: any) {
      console.error('Failed to delete embedded assessment:', err);
      setError('Failed to delete problem');
    }
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

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: '40px' }}>
        <p style={{ color: '#333' }}>Loading problems...</p>
      </div>
    );
  }

  return (
    <div style={{ padding: '20px' }}>

      {/* Header */}
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '20px'
      }}>
        <div>
          <h2 style={{ marginBottom: '10px', color: '#333' }}>Embedded Systems Problems</h2>
          <p style={{ color: '#666', margin: 0 }}>
            Total Problems: <strong>{assessments.length}</strong>
          </p>
        </div>
        {isAdmin && (
          <button
            onClick={() => {
              setIsCreating(!isCreating);
              setError(null);
              if (isCreating) handleCancelCreation();
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
            {isCreating ? 'Cancel' : '➕ Add Problem'}
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

      {/* Creation wizard progress bar */}
      {isAdmin && isCreating && (
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
              width: '30px', height: '30px', borderRadius: '50%',
              background: creationStep === 1 ? '#007bff' : '#28a745',
              color: 'white', display: 'flex', alignItems: 'center',
              justifyContent: 'center', fontWeight: 'bold'
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
              width: '30px', height: '30px', borderRadius: '50%',
              background: creationStep === 2 ? '#007bff' : '#ccc',
              color: 'white', display: 'flex', alignItems: 'center',
              justifyContent: 'center', fontWeight: 'bold'
            }}>
              2
            </div>
            <span style={{ fontWeight: creationStep === 2 ? 'bold' : 'normal', color: '#333' }}>
              Add Rubric Criteria
            </span>
          </div>
        </div>
      )}

      {/* Step 1: Problem Details */}
      {isAdmin && isCreating && creationStep === 1 && (
        <div style={{
          background: '#f8f9fa', padding: '20px', borderRadius: '8px',
          marginBottom: '20px', border: '1px solid #dee2e6'
        }}>
          <h3 style={{ color: '#333', marginTop: 0 }}>Step 1: Problem Details</h3>

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

          <div style={{ display: 'flex', gap: '10px' }}>
            <button
              onClick={() => {
                if (!newAssessment.title.trim()) { setError('Title is required'); return; }
                setError(null);
                setCreationStep(2);
              }}
              style={{
                padding: '12px 24px', background: '#007bff', color: 'white',
                border: 'none', borderRadius: '6px', cursor: 'pointer',
                fontSize: '15px', fontWeight: 'bold'
              }}
            >
              Next: Add Rubric →
            </button>
            <button
              onClick={handleCancelCreation}
              style={{
                padding: '12px 24px', background: '#dc3545', color: 'white',
                border: 'none', borderRadius: '6px', cursor: 'pointer',
                fontSize: '15px', fontWeight: 'bold'
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Step 2: Rubric Criteria */}
      {isAdmin && isCreating && creationStep === 2 && (
        <div style={{
          background: '#f8f9fa', padding: '20px', borderRadius: '8px',
          marginBottom: '20px', border: '1px solid #dee2e6'
        }}>
          <h3 style={{ color: '#333', marginTop: 0 }}>Step 2: Add Rubric Criteria</h3>
          <p style={{ color: '#666', fontSize: '14px', marginBottom: '16px' }}>
            Each criterion is one thing that will be checked in the student's code. Be specific.
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
                  padding: '8px 12px',
                  background: rubric.length === 1 ? '#dee2e6' : '#dc3545',
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
              cursor: 'pointer', fontSize: '14px', marginBottom: '20px',
              display: 'block'
            }}
          >
            + Add Criterion
          </button>

          <div style={{ display: 'flex', gap: '10px' }}>
            <button
              onClick={handleCreateAssessment}
              style={{
                padding: '12px 24px', background: '#28a745', color: 'white',
                border: 'none', borderRadius: '6px', cursor: 'pointer',
                fontSize: '15px', fontWeight: 'bold'
              }}
            >
              ✓ Create Problem
            </button>
            <button
              onClick={() => setCreationStep(1)}
              style={{
                padding: '12px 24px', background: '#6c757d', color: 'white',
                border: 'none', borderRadius: '6px', cursor: 'pointer',
                fontSize: '15px', fontWeight: 'bold'
              }}
            >
              ← Back
            </button>
            <button
              onClick={handleCancelCreation}
              style={{
                padding: '12px 24px', background: '#dc3545', color: 'white',
                border: 'none', borderRadius: '6px', cursor: 'pointer',
                fontSize: '15px', fontWeight: 'bold'
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Problems grid */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fill, minmax(350px, 1fr))',
        gap: '20px'
      }}>
        {assessments.map(assessment => {
          const isCompleted = userProfile?.completedMilestones?.some(
            (m: any) => m.milestoneId === assessment.milestoneId
          );
          const completedData = userProfile?.completedMilestones?.find(
            (m: any) => m.milestoneId === assessment.milestoneId
          );

          return (
            <div
              key={assessment.milestoneId}
              style={{
                background: 'white',
                border: '2px solid #dee2e6',
                borderRadius: '8px',
                padding: '20px',
                cursor: 'pointer',
                transition: 'all 0.3s ease',
                boxShadow: '0 2px 4px rgba(0,0,0,0.05)'
              }}
              onMouseEnter={e => {
                e.currentTarget.style.transform = 'translateY(-5px)';
                e.currentTarget.style.boxShadow = '0 4px 12px rgba(0,0,0,0.15)';
              }}
              onMouseLeave={e => {
                e.currentTarget.style.transform = 'translateY(0)';
                e.currentTarget.style.boxShadow = '0 2px 4px rgba(0,0,0,0.05)';
              }}
            >
              {/* Title + difficulty badge */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', marginBottom: '10px' }}>
                <h3 style={{ margin: 0, color: '#333', fontSize: '18px' }}>
                  {assessment.title}
                </h3>
                <span style={{
                  background: getDifficultyColor(assessment.difficulty),
                  color: 'white',
                  padding: '4px 10px',
                  borderRadius: '4px',
                  fontSize: '12px',
                  fontWeight: 'bold',
                  textTransform: 'capitalize'
                }}>
                  {assessment.difficulty}
                </span>
              </div>

              {/* Tags row */}
              <div style={{ display: 'flex', gap: '8px', marginBottom: '15px', flexWrap: 'wrap' }}>
                <span style={{
                  background: '#e7f3ff', color: '#0066cc',
                  padding: '4px 8px', borderRadius: '4px',
                  fontSize: '12px', fontWeight: 'bold'
                }}>
                  C / MSP432
                </span>
                <span style={{
                  background: '#d4edda', color: '#155724',
                  padding: '4px 8px', borderRadius: '4px',
                  fontSize: '12px', fontWeight: 'bold'
                }}>
                  📋 {assessment.rubric.length} criteria
                </span>
                {isCompleted && completedData && (() => {
                  // Read review status from the Submissions table (source of truth)
                  // instead of completedMilestones which doesn't reliably have this field
                  const reviewStatus = submissionStatus[assessment.milestoneId];
                  if (reviewStatus === 'approved') {
                    return (
                      <span style={{
                        background: '#28a745',
                        color: 'white',
                        padding: '4px 8px', borderRadius: '4px',
                        fontSize: '12px', fontWeight: 'bold'
                      }}>
                        ✅ Approved
                      </span>
                    );
                  }
                  if (reviewStatus === 'rejected') {
                    return (
                      <span style={{
                        background: '#dc3545',
                        color: 'white',
                        padding: '4px 8px', borderRadius: '4px',
                        fontSize: '12px', fontWeight: 'bold'
                      }}>
                        ❌ Rejected
                      </span>
                    );
                  }
                  return (
                    <span style={{
                      background: '#007bff',
                      color: 'white',
                      padding: '4px 8px', borderRadius: '4px',
                      fontSize: '12px', fontWeight: 'bold'
                    }}>
                      📋 Under Review
                    </span>
                  );
                })()}
              </div>

              {/* Footer */}
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
                  Added: {new Date(assessment.createdAt).toLocaleDateString()}
                </small>

                <div style={{ display: 'flex', gap: '10px' }}>
                  <button
                    onClick={() => handleOpenEditor(assessment)}
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

                  {isAdmin && (
                    <button
                      onClick={e => {
                        e.stopPropagation();
                        handleDeleteAssessment(assessment.milestoneId);
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
          );
        })}
      </div>

      {assessments.length === 0 && !loading && (
        <div style={{
          textAlign: 'center',
          padding: '60px 20px',
          color: '#999'
        }}>
          <p style={{ fontSize: '18px', marginBottom: '10px' }}>📋 No problems available yet</p>
          <p style={{ fontSize: '14px' }}>
            {isAdmin ? 'Click "Add Problem" to create your first embedded systems challenge!' : 'Check back later for new challenges!'}
          </p>
        </div>
      )}

      {showProctoringInstructions && pendingAssessment && (
        <ProctoringInstructions
          problemTitle={pendingAssessment.title}
          onProceed={handleProctoringGranted}
          onCancel={handleProctoringCancelled}
        />
      )}

      {selectedAssessment && (
        <CodeEditor
          milestone={{
            milestoneId: selectedAssessment.milestoneId,
            title: selectedAssessment.title,
            description: selectedAssessment.description,
            difficulty: selectedAssessment.difficulty,
            language: 'c',
            starterCode: '',
            type: 'embedded'
          }}
          userProfile={userProfile}
          webcamStream={webcamStream}
          screenStream={screenStream}
          onClose={handleCloseEditor}
          onSubmitSuccess={handleSubmitSuccess}
          isViewMode={!webcamStream && !screenStream}
        />
      )}
    </div>
  );
}