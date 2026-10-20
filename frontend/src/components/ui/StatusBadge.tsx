import { Badge, type BadgeVariant } from './Badge';

/**
 * Values match what the app already uses: `pending`, `approved` and `rejected` are the backend
 * `reviewStatus` values; `completed` comes from `completedMilestones`; `not_started` means no
 * attempt exists yet.
 */
export type AssessmentStatus = 'not_started' | 'pending' | 'approved' | 'rejected' | 'completed';

const STATUS_DISPLAY: Record<AssessmentStatus, { label: string; variant: BadgeVariant }> = {
  not_started: { label: 'Not started', variant: 'neutral' },
  pending: { label: 'Under review', variant: 'info' },
  approved: { label: 'Approved', variant: 'success' },
  rejected: { label: 'Rejected', variant: 'danger' },
  completed: { label: 'Completed', variant: 'success' },
};

export interface StatusBadgeProps {
  status: AssessmentStatus;
  className?: string;
}

export function StatusBadge({ status, className }: StatusBadgeProps) {
  const { label, variant } = STATUS_DISPLAY[status];
  return (
    <Badge variant={variant} className={className}>
      {label}
    </Badge>
  );
}
