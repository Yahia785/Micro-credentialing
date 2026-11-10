/** Shapes returned by the interview endpoints (see backend/shared/nodejs/utils/interview-view.js). */

export type InterviewStatus = 'in_progress' | 'completed' | 'timed_out' | 'abandoned';

export interface ClientTiming {
  /** Milliseconds from the question appearing to the first keystroke, or null when the student never typed. */
  firstKeystrokeMs: number | null;
  pasteCount: number;
  focusLossCount: number;
}

/** POST /interviews and POST /interviews/practice. */
export interface StartInterviewResult {
  interviewId: string;
  question: string;
  deadline: string;
  serverNow: string;
  isPractice?: boolean;
}

/** POST /interviews/{id}/answers: the next question, or the end of the interview. */
export type AnswerResult = { question: string; deadline: string } | { ended: true; status: InterviewStatus };

export interface StudentTurn {
  role: 'host' | 'student';
  text: string;
  createdAt: string;
}

/** GET /interviews/{id} for the student who owns the interview. Nothing the agent recorded is in it. */
export interface StudentInterview {
  interviewId: string;
  status: InterviewStatus;
  startedAt: string;
  endedAt: string | null;
  deadline: string;
  timeLeftMs: number;
  serverNow: string;
  currentQuestion: string | null;
  progress: { questionNumber: number; questionCount: number };
  /** The student's own code, only while the interview is running. Null once it has ended. */
  code: string | null;
  turns: StudentTurn[];
}

export interface RubricItem {
  id: string;
  text: string;
}

export interface CheckItem extends RubricItem {
  /** null when no model check was made for this answer. */
  shown: boolean | null;
  /** The student's own quoted words, "not shown", or null when there was no check. */
  evidence: string | null;
}

export interface AgentRepair {
  type: string;
  original?: string;
  from?: string | null;
  to?: string;
  fixed?: boolean;
}

export interface AgentCall {
  step: string;
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number;
}

export interface AgentCheck {
  reason: string | null;
  modelReason?: string;
  engineDecision: boolean;
  fallback: string | null;
  items: CheckItem[];
  missing: string[] | null;
  target: string | null;
  isHint: boolean;
  guard: { fired?: boolean; original?: string; fixedByRetry?: boolean; retryFailed?: boolean } | null;
  repairs: AgentRepair[];
  rejected?: { code: string; reply: string };
  models?: { checker: string; writer: string };
  calls?: AgentCall[];
}

export interface AdminAnswer {
  text: string;
  answeredAt: string;
  clientTiming: { firstKeystrokeMs: number | null; pasteCount: number | null; focusLossCount: number | null } | null;
  check: AgentCheck | null;
}

export interface AdminFollowUp {
  question: string;
  askedAt: string;
  /** How many answers came before this follow-up in its main question. */
  afterAnswer: number;
  isHint: boolean;
  target: string | null;
}

/**
 * One rubric item of a main question, over all its answers: the agent's finding next to the instructor's decision.
 * `agentShown` is null when the agent made no check; `instructorShown` is null until the instructor decides.
 */
export interface RubricSummaryItem extends RubricItem {
  agentShown: boolean | null;
  /** The student's quote from the agent's check, when the agent found the item shown. */
  evidence: string | null;
  instructorShown: boolean | null;
  changed: boolean;
  /** The final value: the instructor's decision when there is one, otherwise the agent's. */
  shown: boolean | null;
}

export interface AdminMainQuestion {
  index: number;
  themeId: string | null;
  themeTitle: string | null;
  question: string;
  askedAt: string;
  rubric: RubricItem[];
  rubricSummary: RubricSummaryItem[];
  answers: AdminAnswer[];
  followUps: AdminFollowUp[];
}

/** Instructor overrides: main question number -> rubric item id -> shown (true) or not shown (false). */
export type ReviewOverrides = Record<string, Record<string, boolean>>;

/** The instructor's saved review of an interview. */
export interface InterviewReview {
  overrides: ReviewOverrides;
  grade: number | null;
  note: string;
  reviewedBy?: string;
  reviewedAt?: string;
}

/** PUT /interviews/{id}/review */
export interface InterviewReviewInput {
  overrides: ReviewOverrides;
  grade: number | null;
  note: string;
}

export interface AdminRawTurn {
  role: 'host' | 'student';
  kind?: 'main' | 'follow_up';
  text: string;
  createdAt: string;
}

/** GET /interviews/{id} for an admin. */
export interface AdminInterview {
  interviewId: string;
  submissionId: string;
  userId: string;
  milestoneId: string;
  status: InterviewStatus;
  isPractice: boolean;
  promptVersion: string | null;
  modelId: string | null;
  checkerModelId: string | null;
  writerModelId: string | null;
  startedAt: string;
  deadline: string;
  endedAt: string | null;
  endReason: string | null;
  /** Total time added to the deadline while the agent worked on the student's answers. */
  extraTimeMs: number;
  timeLeftMs: number;
  serverNow: string;
  code: string | null;
  /** The instructor's saved review, or null before anything was saved. */
  review: InterviewReview | null;
  mainQuestions: AdminMainQuestion[];
  turns: AdminRawTurn[];
}

/** One row of GET /interviews?submissionId=. */
export interface InterviewSummary {
  interviewId: string;
  submissionId: string;
  userId: string;
  isPractice: boolean;
  status: InterviewStatus;
  promptVersion: string | null;
  startedAt: string;
  deadline: string;
  endedAt: string | null;
  turnCount: number;
}

/** What the chat component shows, whichever view it was loaded from. */
export interface ChatInterview {
  interviewId: string;
  status: InterviewStatus;
  deadline: string;
  serverNow: string;
  /** performance.now() when this was received, so the countdown follows the server's clock, not the laptop's. */
  receivedAt: number;
  /** The submitted code, when the server gave it (student view: only while the interview runs). */
  code: string | null;
  turns: StudentTurn[];
  currentQuestion: string | null;
  questionNumber: number;
  /** null when the total is not known (practice interviews before the problem has loaded). */
  questionCount: number | null;
}
