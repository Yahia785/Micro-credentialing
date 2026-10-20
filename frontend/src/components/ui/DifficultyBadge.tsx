import { getDifficultyLabel, type Difficulty } from '../../utils/difficulty';
import { Badge, type BadgeVariant } from './Badge';

const VARIANT_BY_DIFFICULTY: Record<Difficulty, BadgeVariant> = {
  easy: 'success',
  medium: 'warning',
  hard: 'danger',
};

export interface DifficultyBadgeProps {
  difficulty: Difficulty;
  className?: string;
}

export function DifficultyBadge({ difficulty, className }: DifficultyBadgeProps) {
  return (
    <Badge variant={VARIANT_BY_DIFFICULTY[difficulty]} className={className}>
      {getDifficultyLabel(difficulty)}
    </Badge>
  );
}
