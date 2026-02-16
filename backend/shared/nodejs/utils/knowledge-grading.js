/**
 * Grade an MCQ question
 * @param {string[]} selectedOptions - Options selected by student (e.g., ["A", "C"])
 * @param {object} question - The MCQ question object
 * @returns {object} { earnedPoints, maxPoints, isCorrect }
 */
function gradeMCQ(selectedOptions, question) {
  const selected = selectedOptions || [];
  let earnedPoints = 0;
  
  // Sum points for selected options
  for (const option of question.options) {
    if (selected.includes(option.id)) {
      earnedPoints += option.points;
    }
  }
  
  // Floor at 0 (no negative question scores)
  earnedPoints = Math.max(0, earnedPoints);
  
  // Cap at maxPoints
  earnedPoints = Math.min(earnedPoints, question.maxPoints);
  
  return {
    earnedPoints,
    maxPoints: question.maxPoints,
    isCorrect: earnedPoints === question.maxPoints
  };
}

/**
 * Grade a short response question
 * @param {string} answer - Student's answer
 * @param {object} question - The short response question object
 * @returns {object} { earnedPoints, maxPoints, isCorrect }
 */
function gradeShortResponse(answer, question) {
  const studentAnswer = (answer || '').trim();
  const caseSensitive = question.caseSensitive || false;
  
  // Check if answer matches any accepted answer
  const isCorrect = question.acceptedAnswers.some(accepted => {
    const acceptedTrimmed = accepted.trim();
    if (caseSensitive) {
      return studentAnswer === acceptedTrimmed;
    }
    return studentAnswer.toLowerCase() === acceptedTrimmed.toLowerCase();
  });
  
  return {
    earnedPoints: isCorrect ? question.points : 0,
    maxPoints: question.points,
    isCorrect
  };
}

/**
 * Grade an entire knowledge assessment submission
 * @param {object[]} answers - Array of { questionId, type, answer }
 * @param {object[]} questions - Array of question objects from the assessment
 * @returns {object} { results, totalScore, maxScore, percentage, passed }
 */
function gradeKnowledgeAssessment(answers, questions, passingScore) {
  const results = [];
  let totalScore = 0;
  let maxScore = 0;
  
  // Create a map of questions by ID for quick lookup
  const questionMap = new Map();
  for (const q of questions) {
    questionMap.set(q.questionId, q);
  }
  
  // Grade each answer
  for (const answer of answers) {
    const question = questionMap.get(answer.questionId);
    if (!question) {
      continue; // Skip unknown questions
    }
    
    let gradeResult;
    
    if (question.type === 'mcq') {
      gradeResult = gradeMCQ(answer.answer, question);
    } else if (question.type === 'short_response') {
      gradeResult = gradeShortResponse(answer.answer, question);
    } else {
      continue; // Unknown question type
    }
    
    totalScore += gradeResult.earnedPoints;
    maxScore += gradeResult.maxPoints;
    
    results.push({
      questionId: answer.questionId,
      type: question.type,
      answer: answer.answer,
      earnedPoints: gradeResult.earnedPoints,
      maxPoints: gradeResult.maxPoints,
      isCorrect: gradeResult.isCorrect,
      explanation: question.explanation || null
    });
  }
  
  const percentage = maxScore > 0 ? Math.round((totalScore / maxScore) * 100) : 0;
  const passed = percentage >= passingScore;
  
  return {
    results,
    totalScore,
    maxScore,
    percentage,
    passed
  };
}

module.exports = {
  gradeMCQ,
  gradeShortResponse,
  gradeKnowledgeAssessment
};