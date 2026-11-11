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
  /** Null for a real interview: its clock starts when the student's page first opens it. A practice interview has its deadline at once. */
  deadline: string | null;
  timeLimitMinutes?: number;
  questionCount?: number;
  serverNow: string;
  isPractice?: boolean;
  /** "preparing" while the server classifies the code, runs it and (host.v7) analyzes it; the waiting page polls for "ready". */
  prepareStatus?: PrepareStatus;
  /** A real interview only. The page keeps it in memory (never in storage): opening the interview and every answer must carry it. */
  sessionKey?: string;
}

export type PrepareStatus = 'preparing' | 'ready' | 'failed' | 'skipped';

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
  /** Null until the first question is shown (a real interview's clock starts then). */
  deadline: string | null;
  /** "left_page" when the interview was abandoned. */
  endReason?: string | null;
  prepareStatus?: PrepareStatus;
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
  /** host.v6: the checker's note when the observed output of the student's code contradicted their claim (the claim is the quote). */
  contradiction?: { note: string; claim: string | null };
  /** What the student did say about an item that is not shown (the item counts as shown only when the quote states the whole item). */
  partialQuote?: string;
  /** The evidence as a list of exact fragments of the answer, when it is in several places (the quote is them joined). */
  fragments?: string[];
  /** Shown by the answer to a follow-up question, and after a hint when the follow-up was one. */
  viaFollowUp?: boolean;
  afterHint?: boolean;
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

/** host.v6: an answer the engine or the checker took for an attempt to manipulate the interview. */
export interface ManipulationFlag {
  /** instruction, answer_request, rubric_request, authority, long_paste or model */
  kind: string;
  /** What the student wrote (the matching part, at most 300 characters). */
  quote: string;
  source: 'engine' | 'model';
}

export interface AgentCheck {
  reason: string | null;
  /** host.v6: this answer was flagged and counted as no evidence. */
  manipulation?: ManipulationFlag | null;
  modelReason?: string;
  engineDecision: boolean;
  fallback: string | null;
  items: CheckItem[];
  missing: string[] | null;
  target: string | null;
  isHint: boolean;
  /** host.v6: the fixed sentence the engine put in front of the next question. */
  notice?: string | null;
  /** host.v7: findings of the code analysis this answer contradicted (with the student's words) and findings it addressed. */
  contradicted?: Array<{ id: string; quote: string }>;
  addressed?: string[];
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
  /** A rubric item id (r1) or, when targetKind is "finding", the id of a finding of the code analysis (f1). */
  target: string | null;
  targetKind?: 'rubric' | 'finding';
}

/**
 * One rubric item of a main question, over all its answers: the agent's finding next to the instructor's decision.
 * `agentShown` is null when the agent made no check; `instructorShown` is null until the instructor decides.
 */
export interface RubricSummaryItem extends RubricItem {
  agentShown: boolean | null;
  /** The student's quote from the agent's check, when the agent found the item shown. */
  evidence: string | null;
  /** Shown only by an answer to a follow-up (and after a hint). */
  viaFollowUp?: boolean;
  afterHint?: boolean;
  instructorShown: boolean | null;
  changed: boolean;
  /** The final value: the instructor's decision when there is one, otherwise the agent's. */
  shown: boolean | null;
}

/** host.v6: one run of the student's code on an input the instructor chose, as the agent saw it. */
export interface ObservedRun {
  label: string;
  stdin: string;
  /** What the program printed (at most 2,000 characters). */
  stdout: string;
  status: string;
  timeMs: number;
}

/** host.v6: decided once when the interview started. */
export interface CodeStatus {
  compiles: boolean | null;
  passed: number | null;
  total: number | null;
  stubs: string[];
  unfinished: boolean;
}

/** host.v7: one finding of the code analysis. Instructors only. */
export interface CodeFinding {
  id: string;
  kind: 'bug' | 'risk' | 'strength' | 'unfinished';
  concept: string;
  lines: string | null;
  relatedQuestion: number | null;
  evidence: { stdin: string; output: string } | null;
}

/** host.v7: a run the agent chose for the analysis, with its reason. */
export interface AgentRun extends ObservedRun {
  reason: string;
  chosenBy: 'agent';
}

/** host.v7: what the prepare step found. Instructors only; students never see any of it. */
export interface CodeAnalysis {
  status: 'ok' | 'partial' | 'failed' | 'skipped';
  error?: string;
  findings: CodeFinding[];
  runs: AgentRun[];
  runsNote?: string | null;
  plan?: Array<{ label: string; stdin: string; reason: string }>;
  calls?: AgentCall[];
  latencyMs?: number;
}

export interface AdminMainQuestion {
  index: number;
  /** host.v6: what the student's code printed on the inputs set for this question; empty when none were run. */
  runs?: ObservedRun[];
  /** host.v6: why nothing (or not everything) was run: limit_reached, runner_failed or compile_error. */
  runsNote?: string | null;
  /** host.v6: the engine's fixed sentence in front of this question. */
  notice?: string | null;
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
  deadline: string | null;
  endedAt: string | null;
  endReason: string | null;
  /** Total time added to the deadline while the agent worked on the student's answers. */
  extraTimeMs: number;
  timeLeftMs: number;
  serverNow: string;
  code: string | null;
  /** host.v6: the status of the code when the interview started; null for other prompt versions. */
  codeStatus?: CodeStatus | null;
  /** host.v6: every flagged answer with the student's quote. */
  manipulationFlags?: Array<ManipulationFlag & { question: number }>;
  prepareStatus?: PrepareStatus;
  /** host.v7: the findings, the runs the agent chose and what the step cost; null for the other prompt versions. */
  analysis?: CodeAnalysis | null;
  /** The student left the page (or confirmed leaving): when. Their answers until then are in the questions below. */
  abandoned?: { at: string | null; reason: string | null } | null;
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
