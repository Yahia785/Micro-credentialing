export type UserRole = 'user' | 'admin';

/** Review states stored by the backend on a submission's proctoringData. */
export type ReviewStatus = 'pending' | 'approved' | 'rejected';

export interface CompletedMilestone {
  milestoneId: string;
  /** Absent while the submission is under review: the student sees no result until the instructor decides. */
  score?: number;
  passedTests?: number;
  totalTests?: number;
  submissionId: string;
  completedAt: string;
  /** True when automatic grading failed; the instructor will review it. */
  gradingFailed?: boolean;
  /** A problem with the interview: its result is held for the instructor. */
  heldForReview?: boolean;
  /** True while it waits for the instructor. The entry then carries no score. */
  underReview?: boolean;
  /** Present once an admin has reviewed the submission. */
  proctoringData?: {
    reviewStatus?: ReviewStatus;
    reviewedBy?: string;
    reviewedAt?: string;
  };
}

export interface UserProfile {
  userId: string;
  email: string;
  name: string;
  role: UserRole;
  createdAt: string;
  credentialsCount?: number;
  milestonesCompleted?: number;
  completedMilestones?: CompletedMilestone[];
}
