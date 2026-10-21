export type UserRole = 'user' | 'admin';

/** Review states stored by the backend on a submission's proctoringData. */
export type ReviewStatus = 'pending' | 'approved' | 'rejected';

export interface CompletedMilestone {
  milestoneId: string;
  score: number;
  passedTests: number;
  totalTests: number;
  submissionId: string;
  completedAt: string;
  /** True when automatic grading failed; the instructor will review it. */
  gradingFailed?: boolean;
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
