import { useState, useEffect } from 'react';
import {
  getAllKnowledgeAssessments,
  createKnowledgeAssessment,
  deleteKnowledgeAssessment,
} from '../api/knowledge-assessments';

import type {
  KnowledgeAssessment,
  KnowledgeQuestion,
  MCQQuestion,
  ShortResponseQuestion,
  MCQOption
} from '../api/knowledge-assessments';

import { ProctoringInstructions } from './proctoring/ProctoringInstructions';
import { KnowledgeEnvironment } from './KnowledgeEnvironment';

interface KnowledgeAssessmentsTabProps {
  userProfile: any;
  onRefreshNeeded?: () => void;
}

export function KnowledgeAssessmentsTab({ userProfile, onRefreshNeeded }: KnowledgeAssessmentsTabProps) {
  const userRole = userProfile?.role || 'user';
  const isAdmin = userRole === 'admin';

  const [assessments, setAssessments] = useState<KnowledgeAssessment[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isCreating, setIsCreating] = useState(false);
  const [creationStep, setCreationStep] = useState<1 | 2>(1);

  // Proctoring & Assessment Taking State
  const [showProctoringInstructions, setShowProctoringInstructions] = useState(false);
  const [pendingAssessment, setPendingAssessment] = useState<KnowledgeAssessment | null>(null);
  const [selectedAssessment, setSelectedAssessment] = useState<KnowledgeAssessment | null>(null);
  const [webcamStream, setWebcamStream] = useState<MediaStream | null>(null);
  const [screenStream, setScreenStream] = useState<MediaStream | null>(null);

  // Step 1: Assessment metadata
  const [newAssessment, setNewAssessment] = useState({
    title: '',
    description: '',
    timeLimit: 30,
    passingScore: 70,
    bcdiplomaTemplateId: ''
  });

  // Step 2: Questions
  const [questions, setQuestions] = useState<KnowledgeQuestion[]>([]);
  const [isAddingQuestion, setIsAddingQuestion] = useState(false);
  const [questionType, setQuestionType] = useState<'mcq' | 'short_response'>('mcq');

  // MCQ form state
  const [mcqForm, setMcqForm] = useState({
    title: '',
    question: '',
    selectionType: 'single' as 'single' | 'multiple',
    options: [
      { id: 'A', text: '', points: 0 },
      { id: 'B', text: '', points: 0 }
    ] as MCQOption[],
    maxPoints: 1,
    explanation: ''
  });

  // Short response form state
  const [shortResponseForm, setShortResponseForm] = useState({
    title: '',
    question: '',
    acceptedAnswers: [''],
    caseSensitive: false,
    points: 1,
    explanation: ''
  });

  useEffect(() => {
    loadAssessments();
  }, []);

  async function loadAssessments() {
    try {
      setLoading(true);
      setError(null);
      const result = await getAllKnowledgeAssessments();
      setAssessments(result.assessments || []);
    } catch (err: any) {
      console.error('Failed to load knowledge assessments:', err);
      setError('Failed to load knowledge assessments');
    } finally {
      setLoading(false);
    }
  }

  // ==========================================
  // PROCTORING HANDLERS
  // ==========================================

  const handleStartAssessment = (assessment: KnowledgeAssessment) => {
    console.log('Starting assessment:', assessment.title);
    setPendingAssessment(assessment);
    setShowProctoringInstructions(true);
  };

  const handleProctoringGranted = (webcam: MediaStream, screen: MediaStream) => {
    console.log('✅ Proctoring permissions granted');
    setWebcamStream(webcam);
    setScreenStream(screen);
    setShowProctoringInstructions(false);

    if (pendingAssessment) {
      setSelectedAssessment(pendingAssessment);
    }
  };

  const handleProctoringCancelled = () => {
    console.log('❌ Proctoring cancelled');
    setShowProctoringInstructions(false);
    setPendingAssessment(null);
  };

  const handleCloseEnvironment = async () => {
    // Stop recording streams
    if (webcamStream) {
      webcamStream.getTracks().forEach(track => track.stop());
      setWebcamStream(null);
    }
    if (screenStream) {
      screenStream.getTracks().forEach(track => track.stop());
      setScreenStream(null);
    }

    // Reload assessments
    await loadAssessments();

    // Trigger user profile refresh
    if (onRefreshNeeded) {
      onRefreshNeeded();
    }

    setSelectedAssessment(null);
    setPendingAssessment(null);
  };

  const handleSubmitSuccess = async () => {
    console.log('🎉 Assessment submitted successfully');
    await loadAssessments();

    if (onRefreshNeeded) {
      onRefreshNeeded();
    }
  };

  // ==========================================
  // CREATION HANDLERS (Admin)
  // ==========================================

  const handleCreateAssessment = async () => {
    if (!newAssessment.title.trim()) {
      setError('Title is required');
      return;
    }

    if (questions.length === 0) {
      setError('At least one question is required');
      return;
    }

    try {
      setError(null);
      const result = await createKnowledgeAssessment({
        title: newAssessment.title,
        description: newAssessment.description,
        timeLimit: newAssessment.timeLimit,
        passingScore: newAssessment.passingScore,
        questions: questions,
        bcdiplomaTemplateId: newAssessment.bcdiplomaTemplateId || undefined
      });

      console.log('Knowledge assessment created:', result);
      await loadAssessments();
      handleCancelCreation();
    } catch (err: any) {
      console.error('Failed to create knowledge assessment:', err);
      setError('Failed to create knowledge assessment');
    }
  };

  const handleDeleteAssessment = async (assessmentId: string) => {
    if (!window.confirm('Are you sure you want to delete this assessment?')) {
      return;
    }

    try {
      setError(null);
      await deleteKnowledgeAssessment(assessmentId);
      setAssessments(assessments.filter(a => a.milestoneId !== assessmentId));
    } catch (err: any) {
      console.error('Failed to delete assessment:', err);
      setError('Failed to delete assessment');
    }
  };

  const handleCancelCreation = () => {
    setIsCreating(false);
    setCreationStep(1);
    setNewAssessment({
      title: '',
      description: '',
      timeLimit: 30,
      passingScore: 70,
      bcdiplomaTemplateId: ''
    });
    setQuestions([]);
    setIsAddingQuestion(false);
    resetQuestionForms();
    setError(null);
  };

  const resetQuestionForms = () => {
    setMcqForm({
      title: '',
      question: '',
      selectionType: 'single',
      options: [
        { id: 'A', text: '', points: 0 },
        { id: 'B', text: '', points: 0 }
      ],
      maxPoints: 1,
      explanation: ''
    });
    setShortResponseForm({
      title: '',
      question: '',
      acceptedAnswers: [''],
      caseSensitive: false,
      points: 1,
      explanation: ''
    });
  };

  const handleAddMCQOption = () => {
    const nextId = String.fromCharCode(65 + mcqForm.options.length);
    if (mcqForm.options.length < 6) {
      setMcqForm({
        ...mcqForm,
        options: [...mcqForm.options, { id: nextId, text: '', points: 0 }]
      });
    }
  };

  const handleRemoveMCQOption = (index: number) => {
    if (mcqForm.options.length > 2) {
      const newOptions = mcqForm.options.filter((_, i) => i !== index);
      const reIndexed = newOptions.map((opt, i) => ({
        ...opt,
        id: String.fromCharCode(65 + i)
      }));
      setMcqForm({ ...mcqForm, options: reIndexed });
    }
  };

  const handleMCQOptionChange = (index: number, field: 'text' | 'points', value: string | number) => {
    const newOptions = [...mcqForm.options];
    if (field === 'text') {
      newOptions[index].text = value as string;
    } else {
      newOptions[index].points = value as number;
    }
    setMcqForm({ ...mcqForm, options: newOptions });
  };

  const handleAddAcceptedAnswer = () => {
    setShortResponseForm({
      ...shortResponseForm,
      acceptedAnswers: [...shortResponseForm.acceptedAnswers, '']
    });
  };

  const handleRemoveAcceptedAnswer = (index: number) => {
    if (shortResponseForm.acceptedAnswers.length > 1) {
      setShortResponseForm({
        ...shortResponseForm,
        acceptedAnswers: shortResponseForm.acceptedAnswers.filter((_, i) => i !== index)
      });
    }
  };

  const handleAcceptedAnswerChange = (index: number, value: string) => {
    const newAnswers = [...shortResponseForm.acceptedAnswers];
    newAnswers[index] = value;
    setShortResponseForm({ ...shortResponseForm, acceptedAnswers: newAnswers });
  };

  const handleSaveQuestion = () => {
    const questionId = `q_${Date.now()}`;

    if (questionType === 'mcq') {
      if (!mcqForm.title.trim() || !mcqForm.question.trim()) {
        setError('Question title and text are required');
        return;
      }
      if (mcqForm.options.some(opt => !opt.text.trim())) {
        setError('All options must have text');
        return;
      }

      const maxPoints = mcqForm.options
        .filter(opt => opt.points > 0)
        .reduce((sum, opt) => sum + opt.points, 0);

      const newQuestion: MCQQuestion = {
        questionId,
        type: 'mcq',
        title: mcqForm.title,
        question: mcqForm.question,
        options: mcqForm.options,
        selectionType: mcqForm.selectionType,
        maxPoints: maxPoints || 1,
        explanation: mcqForm.explanation || undefined
      };

      setQuestions([...questions, newQuestion]);
    } else {
      if (!shortResponseForm.title.trim() || !shortResponseForm.question.trim()) {
        setError('Question title and text are required');
        return;
      }
      if (shortResponseForm.acceptedAnswers.every(a => !a.trim())) {
        setError('At least one accepted answer is required');
        return;
      }

      const newQuestion: ShortResponseQuestion = {
        questionId,
        type: 'short_response',
        title: shortResponseForm.title,
        question: shortResponseForm.question,
        acceptedAnswers: shortResponseForm.acceptedAnswers.filter(a => a.trim()),
        caseSensitive: shortResponseForm.caseSensitive,
        points: shortResponseForm.points,
        explanation: shortResponseForm.explanation || undefined
      };

      setQuestions([...questions, newQuestion]);
    }

    setIsAddingQuestion(false);
    resetQuestionForms();
    setError(null);
  };

  const handleRemoveQuestion = (index: number) => {
    setQuestions(questions.filter((_, i) => i !== index));
  };

  const getTotalPoints = () => {
    return questions.reduce((sum, q) => {
      if (q.type === 'mcq') {
        return sum + (q as MCQQuestion).maxPoints;
      } else {
        return sum + (q as ShortResponseQuestion).points;
      }
    }, 0);
  };

  // ==========================================
  // RENDER
  // ==========================================

  if (loading) {
    return (
      <div style={{ textAlign: 'center', padding: '40px' }}>
        <p style={{ color: '#333' }}>Loading knowledge assessments...</p>
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
          <h2 style={{ marginBottom: '10px', color: '#333' }}>Knowledge Assessments</h2>
          <p style={{ color: '#666', margin: 0 }}>
            Total Assessments: <strong>{assessments.length}</strong>
          </p>
        </div>
        {isAdmin && (
          <button
            onClick={() => {
              if (isCreating) {
                handleCancelCreation();
              } else {
                setIsCreating(true);
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
            {isCreating ? 'Cancel' : '➕ Create Assessment'}
          </button>
        )}
      </div>

      {/* Error Display */}
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

      {/* Creation Wizard - Same as before, keeping it for brevity */}
      {isAdmin && isCreating && (
        <>
          {/* Progress Steps */}
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
                Assessment Details
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
                Add Questions
              </span>
            </div>
          </div>

          {/* Step 1: Assessment Details */}
          {creationStep === 1 && (
            <div style={{
              background: '#f8f9fa',
              padding: '20px',
              borderRadius: '8px',
              marginBottom: '20px',
              border: '1px solid #dee2e6'
            }}>
              <h3 style={{ color: '#333', marginTop: 0 }}>Step 1: Assessment Details</h3>

              <div style={{ marginBottom: '15px' }}>
                <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold', color: '#333' }}>
                  Title: <span style={{ color: 'red' }}>*</span>
                </label>
                <input
                  type="text"
                  value={newAssessment.title}
                  onChange={(e) => setNewAssessment({ ...newAssessment, title: e.target.value })}
                  placeholder="e.g., JavaScript Fundamentals Quiz"
                  style={{
                    width: '100%',
                    padding: '10px',
                    fontSize: '14px',
                    border: '1px solid #ced4da',
                    borderRadius: '4px',
                    boxSizing: 'border-box'
                  }}
                />
              </div>

              <div style={{ marginBottom: '15px' }}>
                <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold', color: '#333' }}>
                  Description:
                </label>
                <textarea
                  value={newAssessment.description}
                  onChange={(e) => setNewAssessment({ ...newAssessment, description: e.target.value })}
                  placeholder="Describe what this assessment covers..."
                  rows={3}
                  style={{
                    width: '100%',
                    padding: '10px',
                    fontSize: '14px',
                    border: '1px solid #ced4da',
                    borderRadius: '4px',
                    boxSizing: 'border-box',
                    resize: 'vertical'
                  }}
                />
              </div>

              <div style={{ display: 'flex', gap: '20px', marginBottom: '15px' }}>
                <div style={{ flex: 1 }}>
                  <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold', color: '#333' }}>
                    Time Limit (minutes):
                  </label>
                  <input
                    type="number"
                    value={newAssessment.timeLimit}
                    onChange={(e) => setNewAssessment({ ...newAssessment, timeLimit: parseInt(e.target.value) || 30 })}
                    min={1}
                    style={{
                      width: '100%',
                      padding: '10px',
                      fontSize: '14px',
                      border: '1px solid #ced4da',
                      borderRadius: '4px',
                      boxSizing: 'border-box'
                    }}
                  />
                </div>

                <div style={{ flex: 1 }}>
                  <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold', color: '#333' }}>
                    Passing Score (%):
                  </label>
                  <input
                    type="number"
                    value={newAssessment.passingScore}
                    onChange={(e) => setNewAssessment({ ...newAssessment, passingScore: parseInt(e.target.value) || 70 })}
                    min={0}
                    max={100}
                    style={{
                      width: '100%',
                      padding: '10px',
                      fontSize: '14px',
                      border: '1px solid #ced4da',
                      borderRadius: '4px',
                      boxSizing: 'border-box'
                    }}
                  />
                </div>
              </div>

              <div style={{ marginBottom: '15px' }}>
                <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold', color: '#333' }}>
                  BCdiploma Template ID:
                </label>
                <input
                  type="text"
                  value={newAssessment.bcdiplomaTemplateId}
                  onChange={(e) => setNewAssessment({ ...newAssessment, bcdiplomaTemplateId: e.target.value })}
                  placeholder="e.g., 0x13"
                  style={{
                    width: '100%',
                    padding: '10px',
                    fontSize: '14px',
                    border: '1px solid #ced4da',
                    borderRadius: '4px',
                    boxSizing: 'border-box'
                  }}
                />
                <small style={{ color: '#666' }}>Optional: Template ID for credential issuance</small>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
                <button
                  onClick={handleCancelCreation}
                  style={{
                    padding: '10px 20px',
                    background: '#6c757d',
                    color: 'white',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: 'pointer'
                  }}
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    if (!newAssessment.title.trim()) {
                      setError('Title is required');
                      return;
                    }
                    setError(null);
                    setCreationStep(2);
                  }}
                  style={{
                    padding: '10px 20px',
                    background: '#007bff',
                    color: 'white',
                    border: 'none',
                    borderRadius: '4px',
                    cursor: 'pointer'
                  }}
                >
                  Next: Add Questions →
                </button>
              </div>
            </div>
          )}

          {/* Step 2: Add Questions */}
          {creationStep === 2 && (
            <div style={{
              background: '#f8f9fa',
              padding: '20px',
              borderRadius: '8px',
              marginBottom: '20px',
              border: '1px solid #dee2e6'
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
                <div>
                  <h3 style={{ color: '#333', margin: 0 }}>Step 2: Add Questions</h3>
                  <p style={{ color: '#666', margin: '5px 0 0 0' }}>
                    Questions: {questions.length} | Total Points: {getTotalPoints()}
                  </p>
                </div>
                {!isAddingQuestion && (
                  <button
                    onClick={() => setIsAddingQuestion(true)}
                    style={{
                      padding: '8px 16px',
                      background: '#28a745',
                      color: 'white',
                      border: 'none',
                      borderRadius: '4px',
                      cursor: 'pointer'
                    }}
                  >
                    ➕ Add Question
                  </button>
                )}
              </div>

              {/* Question Form */}
              {isAddingQuestion && (
                <div style={{
                  background: '#fff',
                  padding: '20px',
                  borderRadius: '8px',
                  marginBottom: '20px',
                  border: '1px solid #dee2e6'
                }}>
                  <div style={{ marginBottom: '15px' }}>
                    <label style={{ display: 'block', marginBottom: '10px', fontWeight: 'bold', color: '#333' }}>
                      Question Type:
                    </label>
                    <div style={{ display: 'flex', gap: '20px' }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '5px', cursor: 'pointer' }}>
                        <input
                          type="radio"
                          name="questionType"
                          checked={questionType === 'mcq'}
                          onChange={() => setQuestionType('mcq')}
                        />
                        Multiple Choice (MCQ)
                      </label>
                      <label style={{ display: 'flex', alignItems: 'center', gap: '5px', cursor: 'pointer' }}>
                        <input
                          type="radio"
                          name="questionType"
                          checked={questionType === 'short_response'}
                          onChange={() => setQuestionType('short_response')}
                        />
                        Short Response
                      </label>
                    </div>
                  </div>

                  {/* MCQ Form */}
                  {questionType === 'mcq' && (
                    <>
                      <div style={{ marginBottom: '15px' }}>
                        <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold', color: '#333' }}>
                          Question Title: <span style={{ color: 'red' }}>*</span>
                        </label>
                        <input
                          type="text"
                          value={mcqForm.title}
                          onChange={(e) => setMcqForm({ ...mcqForm, title: e.target.value })}
                          placeholder="e.g., Variable Declaration"
                          style={{ width: '100%', padding: '10px', fontSize: '14px', border: '1px solid #ced4da', borderRadius: '4px', boxSizing: 'border-box' }}
                        />
                      </div>

                      <div style={{ marginBottom: '15px' }}>
                        <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold', color: '#333' }}>
                          Question Text: <span style={{ color: 'red' }}>*</span>
                        </label>
                        <textarea
                          value={mcqForm.question}
                          onChange={(e) => setMcqForm({ ...mcqForm, question: e.target.value })}
                          placeholder="Which of the following are valid ways to declare a variable?"
                          rows={3}
                          style={{ width: '100%', padding: '10px', fontSize: '14px', border: '1px solid #ced4da', borderRadius: '4px', boxSizing: 'border-box', resize: 'vertical' }}
                        />
                      </div>

                      <div style={{ marginBottom: '15px' }}>
                        <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold', color: '#333' }}>
                          Selection Type:
                        </label>
                        <select
                          value={mcqForm.selectionType}
                          onChange={(e) => setMcqForm({ ...mcqForm, selectionType: e.target.value as 'single' | 'multiple' })}
                          style={{ padding: '10px', fontSize: '14px', border: '1px solid #ced4da', borderRadius: '4px' }}
                        >
                          <option value="single">Single Answer</option>
                          <option value="multiple">Multiple Answers</option>
                        </select>
                      </div>

                      <div style={{ marginBottom: '15px' }}>
                        <label style={{ display: 'block', marginBottom: '10px', fontWeight: 'bold', color: '#333' }}>
                          Options: <span style={{ color: 'red' }}>*</span>
                        </label>
                        <small style={{ color: '#666', display: 'block', marginBottom: '10px' }}>
                          Set positive points for correct, negative for penalty, 0 for neutral.
                        </small>
                        {mcqForm.options.map((option, index) => (
                          <div key={option.id} style={{ display: 'flex', gap: '10px', marginBottom: '10px', alignItems: 'center' }}>
                            <span style={{ fontWeight: 'bold', width: '25px', color: '#333' }}>{option.id}.</span>
                            <input
                              type="text"
                              value={option.text}
                              onChange={(e) => handleMCQOptionChange(index, 'text', e.target.value)}
                              placeholder="Option text"
                              style={{ flex: 1, padding: '10px', fontSize: '14px', border: '1px solid #ced4da', borderRadius: '4px' }}
                            />
                            <input
                              type="number"
                              value={option.points}
                              onChange={(e) => handleMCQOptionChange(index, 'points', parseInt(e.target.value) || 0)}
                              style={{ width: '80px', padding: '10px', fontSize: '14px', border: '1px solid #ced4da', borderRadius: '4px' }}
                            />
                            <span style={{ color: '#666', fontSize: '12px' }}>pts</span>
                            {mcqForm.options.length > 2 && (
                              <button onClick={() => handleRemoveMCQOption(index)} style={{ padding: '5px 10px', background: '#dc3545', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>✕</button>
                            )}
                          </div>
                        ))}
                        {mcqForm.options.length < 6 && (
                          <button onClick={handleAddMCQOption} style={{ padding: '8px 16px', background: '#6c757d', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>+ Add Option</button>
                        )}
                      </div>

                      <div style={{ marginBottom: '15px' }}>
                        <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold', color: '#333' }}>Explanation:</label>
                        <textarea
                          value={mcqForm.explanation}
                          onChange={(e) => setMcqForm({ ...mcqForm, explanation: e.target.value })}
                          placeholder="Explain the correct answer..."
                          rows={2}
                          style={{ width: '100%', padding: '10px', fontSize: '14px', border: '1px solid #ced4da', borderRadius: '4px', boxSizing: 'border-box', resize: 'vertical' }}
                        />
                      </div>
                    </>
                  )}

                  {/* Short Response Form */}
                  {questionType === 'short_response' && (
                    <>
                      <div style={{ marginBottom: '15px' }}>
                        <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold', color: '#333' }}>
                          Question Title: <span style={{ color: 'red' }}>*</span>
                        </label>
                        <input
                          type="text"
                          value={shortResponseForm.title}
                          onChange={(e) => setShortResponseForm({ ...shortResponseForm, title: e.target.value })}
                          placeholder="e.g., Memory Type"
                          style={{ width: '100%', padding: '10px', fontSize: '14px', border: '1px solid #ced4da', borderRadius: '4px', boxSizing: 'border-box' }}
                        />
                      </div>

                      <div style={{ marginBottom: '15px' }}>
                        <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold', color: '#333' }}>
                          Question Text: <span style={{ color: 'red' }}>*</span>
                        </label>
                        <textarea
                          value={shortResponseForm.question}
                          onChange={(e) => setShortResponseForm({ ...shortResponseForm, question: e.target.value })}
                          placeholder="What does RAM stand for?"
                          rows={3}
                          style={{ width: '100%', padding: '10px', fontSize: '14px', border: '1px solid #ced4da', borderRadius: '4px', boxSizing: 'border-box', resize: 'vertical' }}
                        />
                      </div>

                      <div style={{ marginBottom: '15px' }}>
                        <label style={{ display: 'block', marginBottom: '10px', fontWeight: 'bold', color: '#333' }}>
                          Accepted Answers: <span style={{ color: 'red' }}>*</span>
                        </label>
                        <small style={{ color: '#666', display: 'block', marginBottom: '10px' }}>
                          Add all accepted variations (e.g., "RAM", "Random Access Memory")
                        </small>
                        {shortResponseForm.acceptedAnswers.map((answer, index) => (
                          <div key={index} style={{ display: 'flex', gap: '10px', marginBottom: '10px' }}>
                            <input
                              type="text"
                              value={answer}
                              onChange={(e) => handleAcceptedAnswerChange(index, e.target.value)}
                              placeholder="Accepted answer"
                              style={{ flex: 1, padding: '10px', fontSize: '14px', border: '1px solid #ced4da', borderRadius: '4px' }}
                            />
                            {shortResponseForm.acceptedAnswers.length > 1 && (
                              <button onClick={() => handleRemoveAcceptedAnswer(index)} style={{ padding: '5px 10px', background: '#dc3545', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>✕</button>
                            )}
                          </div>
                        ))}
                        <button onClick={handleAddAcceptedAnswer} style={{ padding: '8px 16px', background: '#6c757d', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>+ Add Variation</button>
                      </div>

                      <div style={{ display: 'flex', gap: '20px', marginBottom: '15px' }}>
                        <div>
                          <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold', color: '#333' }}>Points:</label>
                          <input
                            type="number"
                            value={shortResponseForm.points}
                            onChange={(e) => setShortResponseForm({ ...shortResponseForm, points: parseInt(e.target.value) || 1 })}
                            min={1}
                            style={{ width: '100px', padding: '10px', fontSize: '14px', border: '1px solid #ced4da', borderRadius: '4px' }}
                          />
                        </div>
                        <div>
                          <label style={{ display: 'flex', alignItems: 'center', gap: '10px', cursor: 'pointer', marginTop: '25px' }}>
                            <input
                              type="checkbox"
                              checked={shortResponseForm.caseSensitive}
                              onChange={(e) => setShortResponseForm({ ...shortResponseForm, caseSensitive: e.target.checked })}
                            />
                            Case Sensitive
                          </label>
                        </div>
                      </div>

                      <div style={{ marginBottom: '15px' }}>
                        <label style={{ display: 'block', marginBottom: '5px', fontWeight: 'bold', color: '#333' }}>Explanation:</label>
                        <textarea
                          value={shortResponseForm.explanation}
                          onChange={(e) => setShortResponseForm({ ...shortResponseForm, explanation: e.target.value })}
                          placeholder="Explain the correct answer..."
                          rows={2}
                          style={{ width: '100%', padding: '10px', fontSize: '14px', border: '1px solid #ced4da', borderRadius: '4px', boxSizing: 'border-box', resize: 'vertical' }}
                        />
                      </div>
                    </>
                  )}

                  <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px' }}>
                    <button onClick={() => { setIsAddingQuestion(false); resetQuestionForms(); }} style={{ padding: '10px 20px', background: '#6c757d', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>Cancel</button>
                    <button onClick={handleSaveQuestion} style={{ padding: '10px 20px', background: '#28a745', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>Save Question</button>
                  </div>
                </div>
              )}

              {/* Questions List */}
              {questions.length > 0 && (
                <div style={{ marginBottom: '20px' }}>
                  <h4 style={{ color: '#333', marginBottom: '10px' }}>Added Questions:</h4>
                  {questions.map((q, index) => (
                    <div key={q.questionId} style={{ background: '#fff', padding: '15px', borderRadius: '8px', marginBottom: '10px', border: '1px solid #dee2e6', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <div>
                        <span style={{ background: q.type === 'mcq' ? '#007bff' : '#17a2b8', color: 'white', padding: '2px 8px', borderRadius: '4px', fontSize: '12px', marginRight: '10px' }}>
                          {q.type === 'mcq' ? 'MCQ' : 'Short Response'}
                        </span>
                        <strong style={{ color: '#333' }}>{q.title}</strong>
                        <span style={{ color: '#666', marginLeft: '10px' }}>
                          ({q.type === 'mcq' ? (q as MCQQuestion).maxPoints : (q as ShortResponseQuestion).points} pts)
                        </span>
                      </div>
                      <button onClick={() => handleRemoveQuestion(index)} style={{ padding: '5px 10px', background: '#dc3545', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>Remove</button>
                    </div>
                  ))}
                </div>
              )}

              {/* Step 2 Navigation */}
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <button onClick={() => setCreationStep(1)} style={{ padding: '10px 20px', background: '#6c757d', color: 'white', border: 'none', borderRadius: '4px', cursor: 'pointer' }}>← Back</button>
                <button onClick={handleCreateAssessment} disabled={questions.length === 0} style={{ padding: '10px 20px', background: questions.length === 0 ? '#ccc' : '#28a745', color: 'white', border: 'none', borderRadius: '4px', cursor: questions.length === 0 ? 'not-allowed' : 'pointer' }}>Create Assessment ✓</button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Assessments List */}
      {!isCreating && (
        <div>
          {assessments.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '40px', background: '#f8f9fa', borderRadius: '8px', color: '#666' }}>
              <p>No knowledge assessments available yet.</p>
              {isAdmin && <p>Click "Create Assessment" to add one.</p>}
            </div>
          ) : (
            <div style={{ display: 'grid', gap: '15px' }}>
              {assessments.map((assessment) => (
                <div key={assessment.milestoneId} style={{ background: '#fff', padding: '20px', borderRadius: '8px', border: '1px solid #dee2e6', boxShadow: '0 2px 4px rgba(0,0,0,0.05)' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div style={{ flex: 1 }}>
                      <h3 style={{ color: '#333', margin: '0 0 10px 0' }}>{assessment.title}</h3>
                      {assessment.description && (
                        <p style={{ color: '#666', margin: '0 0 10px 0' }}>{assessment.description}</p>
                      )}
                      <div style={{ display: 'flex', gap: '20px', color: '#666', fontSize: '14px' }}>
                        <span>📝 {assessment.questions?.length || 0} questions</span>
                        <span>⏱️ {assessment.timeLimit} min</span>
                        <span>🎯 {assessment.passingScore}% to pass</span>
                      </div>
                    </div>
                    <div style={{ display: 'flex', gap: '10px' }}>
                      <button
                        onClick={() => handleStartAssessment(assessment)}
                        style={{
                          padding: '10px 20px',
                          background: '#007bff',
                          color: 'white',
                          border: 'none',
                          borderRadius: '4px',
                          cursor: 'pointer'
                        }}
                      >
                        {isAdmin ? 'Preview' : 'Start'}
                      </button>
                      {isAdmin && (
                        <button
                          onClick={() => handleDeleteAssessment(assessment.milestoneId)}
                          style={{
                            padding: '10px 20px',
                            background: '#dc3545',
                            color: 'white',
                            border: 'none',
                            borderRadius: '4px',
                            cursor: 'pointer'
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
      )}

      {/* Proctoring Instructions Modal */}
      {showProctoringInstructions && pendingAssessment && (
        <ProctoringInstructions
          problemTitle={pendingAssessment.title}
          onProceed={handleProctoringGranted}
          onCancel={handleProctoringCancelled}
        />
      )}

      {/* Knowledge Environment (Assessment Taking) */}
      {selectedAssessment && (
        <KnowledgeEnvironment
          assessment={selectedAssessment}
          userProfile={userProfile}
          webcamStream={webcamStream}
          screenStream={screenStream}
          onClose={handleCloseEnvironment}
          onSubmitSuccess={handleSubmitSuccess}
          isViewMode={!webcamStream && !screenStream}
        />
      )}
    </div>
  );
}