import { useState, useEffect } from 'react';
import { API_BASE } from '../api/config';

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
  const [pendingReviews, setPendingReviews] = useState<PendingSubmission[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedSubmission, setSelectedSubmission] = useState<PendingSubmission | null>(null);
  const [webcamUrl, setWebcamUrl] = useState<string | null>(null);
  const [screenUrl, setScreenUrl] = useState<string | null>(null);
  const [loadingVideos, setLoadingVideos] = useState(false);
  const [reviewNotes, setReviewNotes] = useState('');
  const [rejectionReason, setRejectionReason] = useState('');
  const [processing, setProcessing] = useState(false);

  useEffect(() => {
    loadPendingReviews();
  }, []);

  const loadPendingReviews = async () => {
    try {
      setLoading(true);
      setError(null);
      
      const token = await getAuthToken();
      const response = await fetch(`${API_BASE}/credentials/get-pending-reviews`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });

      if (!response.ok) {
        throw new Error('Failed to load pending reviews');
      }

      const data = await response.json();
      setPendingReviews(data.submissions || []);
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
    await loadRecordingUrls(submission.submissionId);
  };

  const handleApprove = async () => {
    if (!selectedSubmission) return;

    if (!window.confirm(`Approve this submission and issue credential to ${selectedSubmission.studentName}?`)) {
      return;
    }

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
          reviewNotes: reviewNotes || 'Approved'
        })
      });

      if (!response.ok) {
        throw new Error('Failed to approve review');
      }

      alert('Review approved! Credential will be issued.');
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

    if (!window.confirm(`Reject this submission? Student will need to retake the problem.`)) {
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
      
      {pendingReviews.length === 0 ? (
        <div style={{
          padding: '40px',
          textAlign: 'center',
          backgroundColor: '#e7f3ff',
          borderRadius: '8px',
          color: '#0066cc'
        }}>
          <p style={{ fontSize: '18px', margin: 0 }}>✅ No pending reviews!</p>
          <p style={{ fontSize: '14px', margin: '10px 0 0 0' }}>All submissions have been reviewed.</p>
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
              Pending ({pendingReviews.length})
            </h3>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
              {pendingReviews.map((submission) => (
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
                  <p style={{ margin: '4px 0', fontSize: '13px', color: '#28a745', fontWeight: 'bold' }}>
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
                    fontFamily: 'inherit'
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
                    fontFamily: 'inherit'
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
                  ✅ Approve & Issue Credential
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