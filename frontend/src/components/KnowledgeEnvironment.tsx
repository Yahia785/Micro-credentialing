import { useState, useEffect, useRef } from 'react';
import {
  submitKnowledgeAssessment,
} from '../api/knowledge-assessments';

import type {
  KnowledgeAssessment,
  MCQQuestion,
  ShortResponseQuestion,
  QuestionAnswer,
  QuestionResult
} from '../api/knowledge-assessments';

interface KnowledgeEnvironmentProps {
  assessment: KnowledgeAssessment;
  userProfile: any;
  webcamStream: MediaStream | null;
  screenStream: MediaStream | null;
  onClose: () => void;
  onSubmitSuccess: () => void;
  isViewMode?: boolean;
}

export function KnowledgeEnvironment({
  assessment,
  onClose,
  onSubmitSuccess,
  isViewMode = false
}: KnowledgeEnvironmentProps) {
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [answers, setAnswers] = useState<Map<string, string | string[]>>(new Map());
  const [timeRemaining, setTimeRemaining] = useState(assessment.timeLimit * 60); // Convert to seconds
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [isSubmitted, setIsSubmitted] = useState(false);
  const [results, setResults] = useState<{
    submissionId: string;
    totalScore: number;
    maxScore: number;
    percentage: number;
    passed: boolean;
    results: QuestionResult[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const timerRef = useRef<NodeJS.Timeout | null>(null);

  const questions = assessment.questions || [];
  const currentQuestion = questions[currentQuestionIndex];

  // Timer countdown
  useEffect(() => {
    if (isViewMode || isSubmitted) return;

    timerRef.current = setInterval(() => {
      setTimeRemaining((prev) => {
        if (prev <= 1) {
          // Time's up - auto submit
          clearInterval(timerRef.current!);
          handleSubmit();
          return 0;
        }
        return prev - 1;
      });
    }, 1000);

    return () => {
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    };
  }, [isViewMode, isSubmitted]);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const getTimerColor = () => {
    if (timeRemaining <= 60) return '#dc3545'; // Red - last minute
    if (timeRemaining <= 300) return '#ffc107'; // Yellow - last 5 minutes
    return '#28a745'; // Green
  };

  const handleMCQAnswer = (questionId: string, optionId: string, selectionType: 'single' | 'multiple') => {
    setAnswers((prev) => {
      const newAnswers = new Map(prev);
      
      if (selectionType === 'single') {
        newAnswers.set(questionId, [optionId]);
      } else {
        const currentAnswer = (newAnswers.get(questionId) as string[]) || [];
        if (currentAnswer.includes(optionId)) {
          // Remove if already selected
          newAnswers.set(questionId, currentAnswer.filter(id => id !== optionId));
        } else {
          // Add to selection
          newAnswers.set(questionId, [...currentAnswer, optionId]);
        }
      }
      
      return newAnswers;
    });
  };

  const handleShortResponseAnswer = (questionId: string, value: string) => {
    setAnswers((prev) => {
      const newAnswers = new Map(prev);
      newAnswers.set(questionId, value);
      return newAnswers;
    });
  };

  const handleSubmit = async () => {
    if (isSubmitting) return;

    const confirmSubmit = isSubmitted || timeRemaining <= 0 || 
      window.confirm('Are you sure you want to submit? You cannot change your answers after submission.');
    
    if (!confirmSubmit && timeRemaining > 0) return;

    try {
      setIsSubmitting(true);
      setError(null);

      // Convert answers map to array format
      const answersArray: QuestionAnswer[] = questions.map((q) => {
        const answer = answers.get(q.questionId);
        return {
          questionId: q.questionId,
          type: q.type,
          answer: answer || (q.type === 'mcq' ? [] : '')
        };
      });

      console.log('Submitting answers:', answersArray);

      const result = await submitKnowledgeAssessment(assessment.milestoneId, answersArray);

      console.log('Submission result:', result);

      setResults(result);
      setIsSubmitted(true);

      // Stop timer
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }

      onSubmitSuccess();
    } catch (err: any) {
      console.error('Failed to submit assessment:', err);
      setError('Failed to submit assessment. Please try again.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const getAnsweredCount = () => {
    return questions.filter(q => {
      const answer = answers.get(q.questionId);
      if (q.type === 'mcq') {
        return Array.isArray(answer) && answer.length > 0;
      }
      return typeof answer === 'string' && answer.trim() !== '';
    }).length;
  };

  const isQuestionAnswered = (questionId: string) => {
    const answer = answers.get(questionId);
    const question = questions.find(q => q.questionId === questionId);
    if (!question) return false;
    
    if (question.type === 'mcq') {
      return Array.isArray(answer) && answer.length > 0;
    }
    return typeof answer === 'string' && answer.trim() !== '';
  };

  // Render Results View
  if (isSubmitted && results) {
    return (
      <div style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        backgroundColor: '#f5f5f5',
        zIndex: 1000,
        overflow: 'auto'
      }}>
        <div style={{
          maxWidth: '900px',
          margin: '0 auto',
          padding: '30px'
        }}>
          {/* Results Header */}
          <div style={{
            background: results.passed ? '#d4edda' : '#f8d7da',
            border: `2px solid ${results.passed ? '#28a745' : '#dc3545'}`,
            borderRadius: '12px',
            padding: '30px',
            textAlign: 'center',
            marginBottom: '30px'
          }}>
            <h1 style={{ 
              color: results.passed ? '#28a745' : '#dc3545', 
              margin: '0 0 15px 0',
              fontSize: '36px'
            }}>
              {results.passed ? '🎉 Congratulations!' : '📚 Keep Learning!'}
            </h1>
            <p style={{ fontSize: '24px', color: '#333', margin: '0 0 10px 0' }}>
              Your Score: <strong>{results.totalScore}</strong> / {results.maxScore} ({results.percentage}%)
            </p>
            <p style={{ fontSize: '18px', color: '#666', margin: 0 }}>
              Passing Score: {assessment.passingScore}%
            </p>
          </div>

          {/* Question-by-Question Results */}
          <div style={{
            background: '#fff',
            borderRadius: '12px',
            padding: '25px',
            marginBottom: '20px',
            boxShadow: '0 2px 8px rgba(0,0,0,0.1)'
          }}>
            <h2 style={{ color: '#333', marginTop: 0 }}>Results Breakdown</h2>
            
            {results.results.map((result, index) => {
              const question = questions.find(q => q.questionId === result.questionId);
              if (!question) return null;

              return (
                <div
                  key={result.questionId}
                  style={{
                    borderBottom: index < results.results.length - 1 ? '1px solid #dee2e6' : 'none',
                    padding: '20px 0'
                  }}
                >
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: '10px' }}>
                    <div style={{ flex: 1 }}>
                      <span style={{
                        background: result.isCorrect ? '#28a745' : '#dc3545',
                        color: 'white',
                        padding: '3px 10px',
                        borderRadius: '4px',
                        fontSize: '12px',
                        marginRight: '10px'
                      }}>
                        {result.isCorrect ? '✓ Correct' : '✗ Incorrect'}
                      </span>
                      <span style={{
                        background: question.type === 'mcq' ? '#007bff' : '#17a2b8',
                        color: 'white',
                        padding: '3px 8px',
                        borderRadius: '4px',
                        fontSize: '11px'
                      }}>
                        {question.type === 'mcq' ? 'MCQ' : 'Short Response'}
                      </span>
                    </div>
                    <span style={{ color: '#666', fontWeight: 'bold' }}>
                      {result.earnedPoints} / {result.maxPoints} pts
                    </span>
                  </div>

                  <h4 style={{ color: '#333', margin: '10px 0' }}>
                    Q{index + 1}: {question.title}
                  </h4>
                  <p style={{ color: '#555', margin: '5px 0 15px 0' }}>{question.question}</p>

                  {/* Show user's answer */}
                  <div style={{ 
                    background: '#f8f9fa', 
                    padding: '10px 15px', 
                    borderRadius: '6px',
                    marginBottom: '10px'
                  }}>
                    <strong style={{ color: '#666' }}>Your Answer: </strong>
                    <span style={{ color: '#333' }}>
                      {question.type === 'mcq' 
                        ? (Array.isArray(result.answer) ? result.answer.join(', ') : 'No answer')
                        : (result.answer || 'No answer')}
                    </span>
                  </div>

                  {/* Show correct answer for MCQ */}
                  {question.type === 'mcq' && !result.isCorrect && (
                    <div style={{ 
                      background: '#d4edda', 
                      padding: '10px 15px', 
                      borderRadius: '6px',
                      marginBottom: '10px'
                    }}>
                      <strong style={{ color: '#155724' }}>Correct Answer(s): </strong>
                      <span style={{ color: '#155724' }}>
                        {(question as MCQQuestion).options
                          .filter(opt => opt.points > 0)
                          .map(opt => opt.id)
                          .join(', ')}
                      </span>
                    </div>
                  )}

                  {/* Show explanation if available */}
                  {result.explanation && (
                    <div style={{ 
                      background: '#e7f3ff', 
                      padding: '10px 15px', 
                      borderRadius: '6px',
                      borderLeft: '4px solid #007bff'
                    }}>
                      <strong style={{ color: '#004085' }}>Explanation: </strong>
                      <span style={{ color: '#004085' }}>{result.explanation}</span>
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Close Button */}
          <div style={{ textAlign: 'center' }}>
            <button
              onClick={onClose}
              style={{
                padding: '15px 40px',
                background: '#007bff',
                color: 'white',
                border: 'none',
                borderRadius: '8px',
                cursor: 'pointer',
                fontSize: '18px',
                fontWeight: 'bold'
              }}
            >
              Back to Assessments
            </button>
          </div>
        </div>
      </div>
    );
  }

  // Render Assessment Taking View
  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      backgroundColor: '#f5f5f5',
      zIndex: 1000,
      display: 'flex',
      flexDirection: 'column'
    }}>
      {/* Header */}
      <div style={{
        background: '#fff',
        padding: '15px 25px',
        borderBottom: '2px solid #dee2e6',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center'
      }}>
        <div>
          <h2 style={{ margin: 0, color: '#333', fontSize: '20px' }}>{assessment.title}</h2>
          <p style={{ margin: '5px 0 0 0', color: '#666', fontSize: '14px' }}>
            Question {currentQuestionIndex + 1} of {questions.length} • 
            Answered: {getAnsweredCount()} / {questions.length}
          </p>
        </div>

        {/* Timer */}
        {!isViewMode && (
          <div style={{
            background: getTimerColor(),
            color: 'white',
            padding: '10px 20px',
            borderRadius: '8px',
            fontSize: '24px',
            fontWeight: 'bold',
            fontFamily: 'monospace'
          }}>
            ⏱️ {formatTime(timeRemaining)}
          </div>
        )}

        <button
          onClick={() => {
            if (window.confirm('Are you sure you want to exit? Your progress will be lost.')) {
              onClose();
            }
          }}
          style={{
            padding: '10px 20px',
            background: '#6c757d',
            color: 'white',
            border: 'none',
            borderRadius: '6px',
            cursor: 'pointer',
            fontWeight: 'bold'
          }}
        >
          Exit
        </button>
      </div>

      {/* Main Content */}
      <div style={{ flex: 1, display: 'flex', overflow: 'hidden' }}>
        {/* Question Navigation Sidebar */}
        <div style={{
          width: '80px',
          background: '#fff',
          borderRight: '1px solid #dee2e6',
          padding: '15px 10px',
          overflowY: 'auto'
        }}>
          <p style={{ fontSize: '12px', color: '#666', textAlign: 'center', margin: '0 0 10px 0' }}>
            Questions
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {questions.map((q, index) => (
              <button
                key={q.questionId}
                onClick={() => setCurrentQuestionIndex(index)}
                style={{
                  width: '50px',
                  height: '50px',
                  margin: '0 auto',
                  border: currentQuestionIndex === index ? '3px solid #007bff' : '2px solid #dee2e6',
                  borderRadius: '8px',
                  background: isQuestionAnswered(q.questionId) ? '#28a745' : '#fff',
                  color: isQuestionAnswered(q.questionId) ? '#fff' : '#333',
                  cursor: 'pointer',
                  fontWeight: 'bold',
                  fontSize: '16px'
                }}
              >
                {index + 1}
              </button>
            ))}
          </div>
        </div>

        {/* Question Content */}
        <div style={{ flex: 1, padding: '30px', overflowY: 'auto' }}>
          {error && (
            <div style={{
              background: '#f8d7da',
              color: '#721c24',
              padding: '15px',
              borderRadius: '8px',
              marginBottom: '20px'
            }}>
              {error}
            </div>
          )}

          {currentQuestion && (
            <div style={{
              background: '#fff',
              borderRadius: '12px',
              padding: '30px',
              boxShadow: '0 2px 8px rgba(0,0,0,0.1)',
              maxWidth: '800px'
            }}>
              {/* Question Header */}
              <div style={{ marginBottom: '20px' }}>
                <span style={{
                  background: currentQuestion.type === 'mcq' ? '#007bff' : '#17a2b8',
                  color: 'white',
                  padding: '4px 12px',
                  borderRadius: '4px',
                  fontSize: '12px',
                  marginRight: '10px'
                }}>
                  {currentQuestion.type === 'mcq' ? 'Multiple Choice' : 'Short Response'}
                </span>
                <span style={{ color: '#666', fontSize: '14px' }}>
                  {currentQuestion.type === 'mcq' 
                    ? `${(currentQuestion as MCQQuestion).maxPoints} points`
                    : `${(currentQuestion as ShortResponseQuestion).points} points`}
                </span>
              </div>

              <h3 style={{ color: '#333', marginTop: 0, marginBottom: '10px', fontSize: '22px' }}>
                {currentQuestion.title}
              </h3>
              <p style={{ color: '#555', fontSize: '16px', lineHeight: '1.6', marginBottom: '25px' }}>
                {currentQuestion.question}
              </p>

              {/* MCQ Options */}
              {currentQuestion.type === 'mcq' && (
                <div>
                  <p style={{ color: '#666', fontSize: '14px', marginBottom: '15px' }}>
                    {(currentQuestion as MCQQuestion).selectionType === 'single' 
                      ? 'Select one answer:' 
                      : 'Select all that apply:'}
                  </p>
                  {(currentQuestion as MCQQuestion).options.map((option) => {
                    const currentAnswer = answers.get(currentQuestion.questionId) as string[] || [];
                    const isSelected = currentAnswer.includes(option.id);
                    const mcq = currentQuestion as MCQQuestion;

                    return (
                      <div
                        key={option.id}
                        onClick={() => handleMCQAnswer(currentQuestion.questionId, option.id, mcq.selectionType)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          padding: '15px',
                          marginBottom: '10px',
                          border: `2px solid ${isSelected ? '#007bff' : '#dee2e6'}`,
                          borderRadius: '8px',
                          cursor: 'pointer',
                          background: isSelected ? '#e7f3ff' : '#fff',
                          transition: 'all 0.2s'
                        }}
                      >
                        <div style={{
                          width: '24px',
                          height: '24px',
                          borderRadius: mcq.selectionType === 'single' ? '50%' : '4px',
                          border: `2px solid ${isSelected ? '#007bff' : '#adb5bd'}`,
                          marginRight: '15px',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          background: isSelected ? '#007bff' : '#fff'
                        }}>
                          {isSelected && (
                            <span style={{ color: '#fff', fontWeight: 'bold' }}>✓</span>
                          )}
                        </div>
                        <span style={{ fontWeight: 'bold', marginRight: '10px', color: '#333' }}>
                          {option.id}.
                        </span>
                        <span style={{ color: '#333', fontSize: '15px' }}>{option.text}</span>
                      </div>
                    );
                  })}
                </div>
              )}

              {/* Short Response Input */}
              {currentQuestion.type === 'short_response' && (
                <div>
                  <input
                    type="text"
                    value={(answers.get(currentQuestion.questionId) as string) || ''}
                    onChange={(e) => handleShortResponseAnswer(currentQuestion.questionId, e.target.value)}
                    placeholder="Type your answer here..."
                    style={{
                      width: '100%',
                      padding: '15px',
                      fontSize: '16px',
                      border: '2px solid #dee2e6',
                      borderRadius: '8px',
                      boxSizing: 'border-box'
                    }}
                  />
                </div>
              )}
            </div>
          )}

          {/* Navigation Buttons */}
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            marginTop: '25px',
            maxWidth: '800px'
          }}>
            <button
              onClick={() => setCurrentQuestionIndex(Math.max(0, currentQuestionIndex - 1))}
              disabled={currentQuestionIndex === 0}
              style={{
                padding: '12px 25px',
                background: currentQuestionIndex === 0 ? '#dee2e6' : '#6c757d',
                color: currentQuestionIndex === 0 ? '#999' : 'white',
                border: 'none',
                borderRadius: '6px',
                cursor: currentQuestionIndex === 0 ? 'not-allowed' : 'pointer',
                fontWeight: 'bold',
                fontSize: '15px'
              }}
            >
              ← Previous
            </button>

            {currentQuestionIndex < questions.length - 1 ? (
              <button
                onClick={() => setCurrentQuestionIndex(currentQuestionIndex + 1)}
                style={{
                  padding: '12px 25px',
                  background: '#007bff',
                  color: 'white',
                  border: 'none',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  fontWeight: 'bold',
                  fontSize: '15px'
                }}
              >
                Next →
              </button>
            ) : (
              <button
                onClick={handleSubmit}
                disabled={isSubmitting}
                style={{
                  padding: '12px 30px',
                  background: isSubmitting ? '#6c757d' : '#28a745',
                  color: 'white',
                  border: 'none',
                  borderRadius: '6px',
                  cursor: isSubmitting ? 'not-allowed' : 'pointer',
                  fontWeight: 'bold',
                  fontSize: '15px'
                }}
              >
                {isSubmitting ? 'Submitting...' : '✓ Submit Assessment'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}