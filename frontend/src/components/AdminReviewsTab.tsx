import { useState, useEffect } from 'react';
import { API_BASE } from '../api/config';

// TODO: Make this per-assessment configurable (should match backend PASSING_THRESHOLD)
const PASSING_THRESHOLD = 83;

interface RubricResult {
  criterion: string;
  passed: boolean;
  feedback: string;
}

interface PendingSubmission {
  submissionId: string;
  userId: string;
  milestoneId: string;
  milestoneType?: string;
  studentName: string;
  studentEmail: string;
  problemTitle: string;
  score: number;
  passedTests: number;
  totalTests: number;
  passedCriteria?: number;
  totalCriteria?: number;
  rubricResults?: RubricResult[];
  submittedAt: string;
  code?: string;
  proctoringData?: {
    recordings?: {
      webcam?: { s3Key: string; uploadedAt: string };
      screen?: { s3Key: string; uploadedAt: string };
    };
    startedAt?: string;
    completedAt?: string;
  };
}

export function AdminReviewsTab() {
  const [activeSubTab, setActiveSubTab] = useState<'passed' | 'failed'>('passed');
  const [passedReviews, setPassedReviews] = useState<PendingSubmission[]>([]);
  const [failedReviews, setFailedReviews] = useState<PendingSubmission[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedSubmission, setSelectedSubmission] = useState<PendingSubmission | null>(null);
  const [webcamUrl, setWebcamUrl] = useState<string | null>(null);
  const [screenUrl, setScreenUrl] = useState<string | null>(null);
  const [loadingVideos, setLoadingVideos] = useState(false);
  const [reviewNotes, setReviewNotes] = useState('');
  const [rejectionReason, setRejectionReason] = useState('');
  const [adjustedScore, setAdjustedScore] = useState<string>('');
  const [processing, setProcessing] = useState(false);
  const [criteriaModifications, setCriteriaModifications] = useState<{ [key: number]: boolean }>({});

  useEffect(() => {
    loadPendingReviews();
  }, []);

  const loadPendingReviews = async () => {
    try {
      setLoading(true);
      setError(null);
      
      const token = await getAuthToken();
      
      const [passedRes, failedRes] = await Promise.all([
        fetch(`${API_BASE}/credentials/get-pending-reviews?filter=passed`, {
          headers: { 'Authorization': `Bearer ${token}` }
        }),
        fetch(`${API_BASE}/credentials/get-pending-reviews?filter=failed`, {
          headers: { 'Authorization': `Bearer ${token}` }
        })
      ]);

      if (!passedRes.ok || !failedRes.ok) {
        throw new Error('Failed to load pending reviews');
      }

      const passedData = await passedRes.json();
      const failedData = await failedRes.json();
      
      setPassedReviews(passedData.submissions || []);
      setFailedReviews(failedData.submissions || []);
    } catch (err: any) {
      console.error('Error loading pending reviews:', err);
      setError(err.message);
    } finally {
      setLoading(false);
    }
  };

  const loadRecordingUrls = async (submissionId: string) => {
    try {
      setLoadingVideos(true);
      setWebcamUrl(null);
      setScreenUrl(null);
      
      const token = await getAuthToken();
      const response = await fetch(`${API_BASE}/credentials/get-recording-urls/${submissionId}`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (!response.ok) {
        throw new Error('Failed to load recording URLs');
      }

      const data = await response.json();
      setWebcamUrl(data.urls.webcam || null);
      setScreenUrl(data.urls.screen || null);
    } catch (err: any) {
      console.error('Error loading recordings:', err);
      alert(`Failed to load recordings: ${err.message}`);
    } finally {
      setLoadingVideos(false);
    }
  };

  const handleSelectSubmission = async (submission: PendingSubmission) => {
    setSelectedSubmission(submission);
    setReviewNotes('');
    setRejectionReason('');
    setAdjustedScore('');
    setCriteriaModifications({});
    await loadRecordingUrls(submission.submissionId);
  };

  const handleApprove = async () => {
    if (!selectedSubmission) return;

    const scoreOverride = adjustedScore.trim() !== '' ? parseInt(adjustedScore) : null;
    
    if (scoreOverride !== null && (isNaN(scoreOverride) || scoreOverride < 0 || scoreOverride > 100)) {
      alert('Adjusted score must be a number between 0 and 100');
      return;
    }

    const effectiveScore = scoreOverride !== null ? scoreOverride : selectedSubmission.score;
    const willIssueCredential = effectiveScore >= PASSING_THRESHOLD;
    
    const confirmMessage = willIssueCredential
      ? `Approve this submission and issue credential to ${selectedSubmission.studentName}? (Score: ${effectiveScore}%)`
      : `Approve this submission for ${selectedSubmission.studentName}? No credential will be issued (score: ${effectiveScore}%, threshold: ${PASSING_THRESHOLD}%).`;

    if (!window.confirm(confirmMessage)) return;

    try {
      setProcessing(true);
      
      const token = await getAuthToken();
      const response = await fetch(`${API_BASE}/credentials/approve-review`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          submissionId: selectedSubmission.submissionId,
          reviewNotes: reviewNotes || 'Approved',
          ...(scoreOverride !== null && { adjustedScore: scoreOverride }),
          ...(Object.keys(criteriaModifications).length > 0 && { criteriaModifications })
        })
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.message || 'Failed to approve review');
      }

      alert(willIssueCredential 
        ? 'Review approved! Credential will be issued.' 
        : 'Review approved. No credential issued.');
      setSelectedSubmission(null);
      await loadPendingReviews();
    } catch (err: any) {
      console.error('Error approving review:', err);
      alert(`Failed to approve: ${err.message}`);
    } finally {
      setProcessing(false);
    }
  };

  const handleReject = async () => {
    if (!selectedSubmission) return;

    if (!rejectionReason.trim()) {
      alert('Please provide a reason for rejection');
      return;
    }

    if (!window.confirm(`Reject this submission? This will be recorded as an integrity concern.`)) {
      return;
    }

    try {
      setProcessing(true);
      
      const token = await getAuthToken();
      const response = await fetch(`${API_BASE}/proctoring/reject-review`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({
          submissionId: selectedSubmission.submissionId,
          rejectionReason: rejectionReason
        })
      });

      if (!response.ok) {
        throw new Error('Failed to reject review');
      }

      alert('Review rejected.');
      setSelectedSubmission(null);
      await loadPendingReviews();
    } catch (err: any) {
      console.error('Error rejecting review:', err);
      alert(`Failed to reject: ${err.message}`);
    } finally {
      setProcessing(false);
    }
  };

  // Derive the displayed list from active sub-tab
  const displayedReviews = activeSubTab === 'passed' ? passedReviews : failedReviews;

  if (loading) {
    return (
      <div style={{ padding: '20px', textAlign: 'center' }}>
        <p>Loading pending reviews...</p>
      </div>
    );
  }

  if (error) {
    return (
      <div style={{ padding: '20px' }}>
        <div style={{
          backgroundColor: '#f8d7da',
          color: '#721c24',
          padding: '15px',
          borderRadius: '8px'
        }}>
          Error: {error}
        </div>
      </div>
    );
  }

  return (
    <div style={{ padding: '20px' }}>
      <h2 style={{ marginBottom: '20px', color: '#333' }}>Proctoring Reviews</h2>

      {/* Sub-tab switcher */}
      <div style={{ display: 'flex', gap: '0', marginBottom: '20px' }}>
        <button
          onClick={() => { setActiveSubTab('passed'); setSelectedSubmission(null); }}
          style={{
            padding: '10px 20px',
            backgroundColor: activeSubTab === 'passed' ? '#28a745' : '#f8f9fa',
            color: activeSubTab === 'passed' ? 'white' : '#333',
            border: '1px solid #dee2e6',
            borderRadius: '6px 0 0 6px',
            cursor: 'pointer',
            fontSize: '14px',
            fontWeight: 'bold'
          }}
        >
          ✅ Passed ({passedReviews.length})
        </button>
        <button
          onClick={() => { setActiveSubTab('failed'); setSelectedSubmission(null); }}
          style={{
            padding: '10px 20px',
            backgroundColor: activeSubTab === 'failed' ? '#dc3545' : '#f8f9fa',
            color: activeSubTab === 'failed' ? 'white' : '#333',
            border: '1px solid #dee2e6',
            borderLeft: 'none',
            borderRadius: '0 6px 6px 0',
            cursor: 'pointer',
            fontSize: '14px',
            fontWeight: 'bold'
          }}
        >
          ❌ Failed ({failedReviews.length})
        </button>
      </div>
      
      {displayedReviews.length === 0 ? (
        <div style={{
          padding: '40px',
          textAlign: 'center',
          backgroundColor: '#e7f3ff',
          borderRadius: '8px',
          color: '#0066cc'
        }}>
          <p style={{ fontSize: '18px', margin: 0 }}>
            {activeSubTab === 'passed' ? '✅ No passed submissions pending review!' : '✅ No failed submissions pending review!'}
          </p>
          <p style={{ fontSize: '14px', margin: '10px 0 0 0' }}>All {activeSubTab} submissions have been reviewed.</p>
        </div>
      ) : (
        <div style={{
          display: 'grid',
          gridTemplateColumns: selectedSubmission ? '350px 1fr' : '1fr',
          gap: '20px'
        }}>
          {/* Left: List of pending reviews */}
          <div>
            <h3 style={{ color: '#333', marginBottom: '15px' }}>
              {activeSubTab === 'passed' ? 'Passed' : 'Failed'} ({displayedReviews.length})
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {displayedReviews.map((submission) => (
                <div
                  key={submission.submissionId}
                  onClick={() => handleSelectSubmission(submission)}
                  style={{
                    padding: '15px',
                    backgroundColor: selectedSubmission?.submissionId === submission.submissionId 
                      ? '#e7f3ff' 
                      : 'white',
                    border: selectedSubmission?.submissionId === submission.submissionId
                      ? '2px solid #007bff'
                      : '1px solid #dee2e6',
                    borderRadius: '8px',
                    cursor: 'pointer',
                    transition: 'all 0.2s'
                  }}
                  onMouseEnter={(e) => {
                    if (selectedSubmission?.submissionId !== submission.submissionId) {
                      e.currentTarget.style.backgroundColor = '#f8f9fa';
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (selectedSubmission?.submissionId !== submission.submissionId) {
                      e.currentTarget.style.backgroundColor = 'white';
                    }
                  }}
                >
                  <h4 style={{ margin: '0 0 8px 0', color: '#333', fontSize: '16px' }}>
                    {submission.studentName}
                  </h4>
                  <p style={{ margin: '4px 0', fontSize: '14px', color: '#666' }}>
                    {submission.problemTitle}
                  </p>
                  <p style={{ 
                    margin: '4px 0', fontSize: '13px', fontWeight: 'bold',
                    color: submission.score >= PASSING_THRESHOLD ? '#28a745' : '#dc3545'
                  }}>
                    Score: {submission.milestoneType === 'embedded'
                      ? `${submission.passedCriteria ?? 0}/${submission.totalCriteria ?? 0} criteria (${submission.score}%)`
                      : `${submission.passedTests}/${submission.totalTests} (${submission.score}%)`
                    }
                  </p>
                  <p style={{ margin: '4px 0', fontSize: '12px', color: '#999' }}>
                    {new Date(submission.submittedAt).toLocaleString()}
                  </p>
                </div>
              ))}
            </div>
          </div>

          {/* Right: Selected submission details */}
          {selectedSubmission && (
            <div style={{
              backgroundColor: 'white',
              border: '1px solid #dee2e6',
              borderRadius: '8px',
              padding: '20px'
            }}>
              <h3 style={{ marginTop: 0, color: '#333' }}>Review Submission</h3>
              
              {/* Student Info */}
              <div style={{ marginBottom: '20px' }}>
                <p style={{ margin: '5px 0', color: '#000' }}><strong>Student:</strong> {selectedSubmission.studentName}</p>
                <p style={{ margin: '5px 0', color: '#000' }}><strong>Email:</strong> {selectedSubmission.studentEmail}</p>
                <p style={{ margin: '5px 0', color: '#000' }}><strong>Problem:</strong> {selectedSubmission.problemTitle}</p>
                <p style={{ margin: '5px 0', color: '#000' }}>
                  <strong>Score:</strong>{' '}
                  {selectedSubmission.milestoneType === 'embedded'
                    ? `${selectedSubmission.passedCriteria ?? 0} / ${selectedSubmission.totalCriteria ?? 0} criteria (${selectedSubmission.score}%)`
                    : `${selectedSubmission.passedTests}/${selectedSubmission.totalTests} (${selectedSubmission.score}%)`
                  }
                </p>
                <p style={{ margin: '5px 0', color: '#000' }}>
                  <strong>Passing threshold:</strong> {PASSING_THRESHOLD}%
                </p>
              </div>

                {/* Rubric breakdown — embedded submissions only */}
                {selectedSubmission.milestoneType === 'embedded' && selectedSubmission.rubricResults && (
                  <div style={{ marginBottom: '20px' }}>
                    <h4 style={{ color: '#333', marginBottom: '12px' }}>AI Grading Breakdown</h4>
                    {selectedSubmission.rubricResults.map((result, index) => (
                      <div
                        key={index}
                        style={{
                          display: 'flex', alignItems: 'flex-start', gap: '10px',
                          padding: '10px', marginBottom: '8px',
                          background: result.passed ? '#d4edda' : '#f8d7da',
                          borderRadius: '6px',
                          border: `1px solid ${result.passed ? '#c3e6cb' : '#f5c6cb'}`
                        }}
                      >
                        <span style={{
                          background: result.passed ? '#28a745' : '#dc3545',
                          color: 'white', padding: '2px 8px', borderRadius: '4px',
                          fontSize: '11px', whiteSpace: 'nowrap', flexShrink: 0
                        }}>
                          {result.passed ? '✓' : '✗'}
                        </span>
                        <div>
                          <p style={{ margin: '0 0 4px 0', color: '#333', fontSize: '13px', fontWeight: 'bold' }}>
                            {result.criterion}
                          </p>
                          <p style={{ margin: 0, color: '#555', fontSize: '13px' }}>
                            {result.feedback}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                {/* Criterion Overrides Section */}
                {selectedSubmission.milestoneType === 'embedded' && selectedSubmission.rubricResults && (
                  <div style={{ marginBottom: '20px' }}>
                    <h4 style={{ color: '#333', marginBottom: '12px', marginTop: '20px', paddingTop: '20px', borderTop: '1px solid #dee2e6' }}>
                      Criterion Overrides (Optional)
                    </h4>
                    <p style={{ fontSize: '13px', color: '#666', marginBottom: '15px' }}>
                      Override individual criteria independently of the overall score.
                    </p>

                    {selectedSubmission.rubricResults && selectedSubmission.rubricResults.map((result, index) => (
                      <div
                        key={index}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: '15px',
                          padding: '12px',
                          marginBottom: '10px',
                          background: '#f8f9fa',
                          borderRadius: '6px',
                          border: '1px solid #e0e0e0'
                        }}
                      >
                        {/* Current AI status */}
                        <div style={{ flex: 1 }}>
                          <strong style={{ color: '#333', fontSize: '13px' }}>
                            {index + 1}. {result.criterion}
                          </strong>
                          <p style={{ margin: '4px 0 0 0', fontSize: '12px', color: '#666' }}>
                            AI: <span style={{ fontWeight: 'bold', color: result.passed ? '#28a745' : '#dc3545' }}>
                              {result.passed ? '✓ PASS' : '✗ FAIL'}
                            </span>
                          </p>
                        </div>

                        {/* Override buttons */}
                        <div style={{ display: 'flex', gap: '6px' }}>
                          <button
                            onClick={() => {
                              const newMods = { ...criteriaModifications };
                              newMods[index] = true;
                              setCriteriaModifications(newMods);
                            }}
                            style={{
                              padding: '6px 12px',
                              background: criteriaModifications[index] === true ? '#28a745' : '#f0f0f0',
                              color: criteriaModifications[index] === true ? 'white' : '#333',
                              border: `1px solid ${criteriaModifications[index] === true ? '#28a745' : '#ccc'}`,
                              borderRadius: '4px',
                              cursor: 'pointer',
                              fontSize: '12px',
                              fontWeight: 'bold',
                              transition: 'all 0.2s'
                            }}
                          >
                            ✓ PASS
                          </button>

                          <button
                            onClick={() => {
                              const newMods = { ...criteriaModifications };
                              newMods[index] = false;
                              setCriteriaModifications(newMods);
                            }}
                            style={{
                              padding: '6px 12px',
                              background: criteriaModifications[index] === false ? '#dc3545' : '#f0f0f0',
                              color: criteriaModifications[index] === false ? 'white' : '#333',
                              border: `1px solid ${criteriaModifications[index] === false ? '#dc3545' : '#ccc'}`,
                              borderRadius: '4px',
                              cursor: 'pointer',
                              fontSize: '12px',
                              fontWeight: 'bold',
                              transition: 'all 0.2s'
                            }}
                          >
                            ✗ FAIL
                          </button>

                          <button
                            onClick={() => {
                              const newMods = { ...criteriaModifications };
                              delete newMods[index];
                              setCriteriaModifications(newMods);
                            }}
                            style={{
                              padding: '6px 12px',
                              background: (index in criteriaModifications) ? '#f0f0f0' : '#e7f3ff',
                              color: (index in criteriaModifications) ? '#333' : '#0066cc',
                              border: `1px solid ${(index in criteriaModifications) ? '#ccc' : '#0066cc'}`,
                              borderRadius: '4px',
                              cursor: 'pointer',
                              fontSize: '12px',
                              fontWeight: 'bold',
                              transition: 'all 0.2s'
                            }}
                          >
                            AI Result
                          </button>
                        </div>
                      </div>
                    ))}

                    {/* Summary of modifications */}
                    {Object.keys(criteriaModifications).length > 0 && (
                      <div style={{
                        marginTop: '15px',
                        padding: '10px',
                        background: '#e7f3ff',
                        borderRadius: '6px',
                        border: '1px solid #b8daff',
                        color: '#0066cc',
                        fontSize: '13px'
                      }}>
                        <strong>Modified: </strong>
                        {Object.entries(criteriaModifications).map(([idx, val]) => (
                          <span key={idx} style={{ marginRight: '8px' }}>
                            #{parseInt(idx) + 1} → {val ? '✓' : '✗'}
                          </span>
                        ))}
                      </div>
                    )}
                  </div>
                )}

              {/* Submitted Code — embedded submissions only */}
              {selectedSubmission.milestoneType === 'embedded' && selectedSubmission.code && (
                <div style={{ marginBottom: '20px' }}>
                  <h4 style={{ color: '#333', marginBottom: '12px' }}>Submitted Code</h4>
                  <pre style={{
                    backgroundColor: '#1e1e1e',
                    color: '#d4d4d4',
                    padding: '16px',
                    borderRadius: '8px',
                    fontSize: '13px',
                    lineHeight: '1.5',
                    overflow: 'auto',
                    maxHeight: '400px',
                    border: '1px solid #333',
                    fontFamily: "'Consolas', 'Monaco', 'Courier New', monospace",
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word'
                  }}>
                    {selectedSubmission.code}
                  </pre>
                </div>
              )}

              {/* Proctoring Videos */}
              <div style={{ marginBottom: '20px' }}>
                <h4 style={{ color: '#333' }}>Proctoring Recordings</h4>
                
                {loadingVideos ? (
                  <p>Loading videos...</p>
                ) : (
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '15px' }}>
                    {/* Webcam */}
                    <div>
                      <p style={{ fontWeight: 'bold', marginBottom: '8px' }}>📹 Webcam</p>
                      {webcamUrl ? (
                        <video
                          src={webcamUrl}
                          controls
                          style={{
                            width: '100%',
                            maxHeight: '300px',
                            backgroundColor: '#000',
                            borderRadius: '4px'
                          }}
                        />
                      ) : (
                        <p style={{ color: '#999' }}>No webcam recording</p>
                      )}
                    </div>

                    {/* Screen */}
                    <div>
                      <p style={{ fontWeight: 'bold', marginBottom: '8px' }}>🖥️ Screen</p>
                      {screenUrl ? (
                        <video
                          src={screenUrl}
                          controls
                          style={{
                            width: '100%',
                            maxHeight: '300px',
                            backgroundColor: '#000',
                            borderRadius: '4px'
                          }}
                        />
                      ) : (
                        <p style={{ color: '#999' }}>No screen recording</p>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* Score Override */}
              <div style={{ marginBottom: '20px' }}>
                <label style={{
                  display: 'block',
                  fontWeight: 'bold',
                  marginBottom: '8px',
                  color: '#333'
                }}>
                  Override Score (optional):
                </label>
                <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
                  <input
                    type="number"
                    min="0"
                    max="100"
                    value={adjustedScore}
                    onChange={(e) => setAdjustedScore(e.target.value)}
                    placeholder={`Current: ${selectedSubmission.score}%`}
                    style={{
                      padding: '10px',
                      fontSize: '14px',
                      border: '1px solid #ced4da',
                      borderRadius: '4px',
                      width: '150px'
                    }}
                  />
                  <span style={{ color: '#666', fontSize: '13px' }}>
                    AI score: {selectedSubmission.score}% — Leave blank to keep as-is
                  </span>
                </div>
                {adjustedScore.trim() !== '' && !isNaN(parseInt(adjustedScore)) && (
                  <p style={{ 
                    margin: '8px 0 0 0', fontSize: '13px', fontWeight: 'bold',
                    color: parseInt(adjustedScore) >= PASSING_THRESHOLD ? '#28a745' : '#dc3545'
                  }}>
                    {parseInt(adjustedScore) >= PASSING_THRESHOLD 
                      ? `✅ Adjusted score (${adjustedScore}%) meets passing threshold — credential will be issued`
                      : `❌ Adjusted score (${adjustedScore}%) below passing threshold — no credential`
                    }
                  </p>
                )}
              </div>

              {/* Review Notes */}
              <div style={{ marginBottom: '20px' }}>
                <label style={{
                  display: 'block',
                  fontWeight: 'bold',
                  marginBottom: '8px',
                  color: '#333'
                }}>
                  Review Notes (optional):
                </label>
                <textarea
                  value={reviewNotes}
                  onChange={(e) => setReviewNotes(e.target.value)}
                  placeholder="Add any notes about this review..."
                  style={{
                    width: '100%',
                    padding: '10px',
                    fontSize: '14px',
                    border: '1px solid #ced4da',
                    borderRadius: '4px',
                    minHeight: '80px',
                    fontFamily: 'inherit',
                    boxSizing: 'border-box'
                  }}
                />
              </div>

              {/* Rejection Reason */}
              <div style={{ marginBottom: '20px' }}>
                <label style={{
                  display: 'block',
                  fontWeight: 'bold',
                  marginBottom: '8px',
                  color: '#333'
                }}>
                  Rejection Reason (if rejecting):
                </label>
                <textarea
                  value={rejectionReason}
                  onChange={(e) => setRejectionReason(e.target.value)}
                  placeholder="e.g., Detected cheating, Multiple people visible, Tab switching..."
                  style={{
                    width: '100%',
                    padding: '10px',
                    fontSize: '14px',
                    border: '1px solid #ced4da',
                    borderRadius: '4px',
                    minHeight: '80px',
                    fontFamily: 'inherit',
                    boxSizing: 'border-box'
                  }}
                />
              </div>

              {/* Action Buttons */}
              <div style={{ display: 'flex', gap: '10px' }}>
                <button
                  onClick={handleApprove}
                  disabled={processing}
                  style={{
                    flex: 1,
                    padding: '12px 20px',
                    backgroundColor: processing ? '#6c757d' : '#28a745',
                    color: 'white',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: processing ? 'not-allowed' : 'pointer',
                    fontSize: '16px',
                    fontWeight: 'bold'
                  }}
                >
                  {(() => {
                    const scoreOverride = adjustedScore.trim() !== '' ? parseInt(adjustedScore) : null;
                    const effectiveScore = scoreOverride !== null ? scoreOverride : (selectedSubmission?.score ?? 0);
                    const willIssue = effectiveScore >= PASSING_THRESHOLD;
                    return willIssue ? '✅ Approve & Issue Credential' : '✅ Approve (No Credential)';
                  })()}
                </button>

                <button
                  onClick={handleReject}
                  disabled={processing}
                  style={{
                    flex: 1,
                    padding: '12px 20px',
                    backgroundColor: processing ? '#6c757d' : '#dc3545',
                    color: 'white',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: processing ? 'not-allowed' : 'pointer',
                    fontSize: '16px',
                    fontWeight: 'bold'
                  }}
                >
                  ❌ Reject
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

async function getAuthToken(): Promise<string> {
  const { fetchAuthSession } = await import('aws-amplify/auth');
  const session = await fetchAuthSession();
  const token = session.tokens?.idToken?.toString();
  if (!token) {
    throw new Error('No authentication token available');
  }
  return token;
}