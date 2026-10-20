import { useState } from 'react';
import type { ReactNode } from 'react';
import {
  Alert,
  Badge,
  Button,
  Card,
  DifficultyBadge,
  EmptyState,
  FormField,
  Input,
  PageHeader,
  Select,
  Spinner,
  StatusBadge,
  Textarea,
} from '../../components/ui';
import type {
  AlertVariant,
  AssessmentStatus,
  BadgeVariant,
  ButtonVariant,
  SpinnerSize,
} from '../../components/ui';
import { DIFFICULTIES } from '../../utils/difficulty';
import styles from './UiShowcase.module.css';

const BUTTON_VARIANTS: ButtonVariant[] = ['primary', 'secondary', 'danger', 'ghost'];
const BADGE_VARIANTS: BadgeVariant[] = ['neutral', 'info', 'success', 'warning', 'danger'];
const ALERT_VARIANTS: AlertVariant[] = ['info', 'success', 'warning', 'danger'];
const SPINNER_SIZES: SpinnerSize[] = ['sm', 'md', 'lg'];
const STATUSES: AssessmentStatus[] = ['not_started', 'pending', 'approved', 'rejected', 'completed'];

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={styles.section}>
      <h2 className={styles.sectionTitle}>{title}</h2>
      {children}
    </section>
  );
}

/** Development-only reference page rendering every UI component in every variant. */
export default function UiShowcase() {
  const [dismissed, setDismissed] = useState<Partial<Record<AlertVariant, boolean>>>({});
  const [title, setTitle] = useState('');
  const titleError = title.trim() === '' ? 'Enter a title for the problem.' : undefined;

  return (
    <div className={styles.page}>
      <PageHeader
        title="UI components"
        subtitle="Every component in every variant. Development reference only."
        actions={<Button>Add problem</Button>}
      />

      <Section title="Button">
        {(['md', 'sm'] as const).map((size) => (
          <div key={size}>
            <p className={styles.caption}>Size {size}</p>
            <div className={styles.row}>
              {BUTTON_VARIANTS.map((variant) => (
                <Button key={variant} variant={variant} size={size}>
                  {variant}
                </Button>
              ))}
            </div>
            <div className={styles.row}>
              {BUTTON_VARIANTS.map((variant) => (
                <Button key={variant} variant={variant} size={size} disabled>
                  {variant} disabled
                </Button>
              ))}
            </div>
            <div className={styles.row}>
              {BUTTON_VARIANTS.map((variant) => (
                <Button key={variant} variant={variant} size={size} loading>
                  Submitting…
                </Button>
              ))}
            </div>
            <div className={styles.row}>
              {BUTTON_VARIANTS.map((variant) => (
                <Button
                  key={variant}
                  variant={variant}
                  size={size}
                  icon={
                    <svg viewBox="0 0 16 16" width="16" height="16" focusable="false">
                      <path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                    </svg>
                  }
                >
                  With icon
                </Button>
              ))}
            </div>
          </div>
        ))}
      </Section>

      <Section title="Card">
        <div className={styles.grid}>
          <Card>Body only.</Card>
          <Card title="Card with header" actions={<Button size="sm" variant="secondary">Edit</Button>}>
            Header with a title and an actions slot.
          </Card>
          <Card
            title="Card with footer"
            footer={
              <>
                <span>Added 1 Sep 2026</span>
                <Button size="sm">Start assessment</Button>
              </>
            }
          >
            Body text with a footer below.
          </Card>
          <Card
            interactive
            title="Interactive card"
            footer={<Button size="sm">Open</Button>}
          >
            Hover or focus inside to see the border and shadow change.
          </Card>
        </div>
      </Section>

      <Section title="Badge">
        <div className={styles.row}>
          {BADGE_VARIANTS.map((variant) => (
            <Badge key={variant} variant={variant}>
              {variant}
            </Badge>
          ))}
        </div>
      </Section>

      <Section title="DifficultyBadge">
        <div className={styles.row}>
          {DIFFICULTIES.map((difficulty) => (
            <DifficultyBadge key={difficulty} difficulty={difficulty} />
          ))}
        </div>
      </Section>

      <Section title="StatusBadge">
        <div className={styles.row}>
          {STATUSES.map((status) => (
            <StatusBadge key={status} status={status} />
          ))}
        </div>
      </Section>

      <Section title="Input, Textarea, Select, FormField">
        <div className={styles.stack}>
          <FormField label="Title" required hint="Shown to students in the assessment list." error={titleError}>
            <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Reverse a string" />
          </FormField>
          <FormField label="Description" hint="Optional. Plain text.">
            <Textarea />
          </FormField>
          <FormField label="Difficulty">
            <Select defaultValue="medium">
              {DIFFICULTIES.map((difficulty) => (
                <option key={difficulty} value={difficulty}>
                  {difficulty}
                </option>
              ))}
            </Select>
          </FormField>
          <FormField label="Disabled input" hint="This field can't be edited right now.">
            <Input disabled defaultValue="Read only value" />
          </FormField>
          <FormField label="Invalid select" error="Choose a difficulty.">
            <Select defaultValue="">
              <option value="" disabled>
                Select a difficulty
              </option>
              <option value="easy">easy</option>
            </Select>
          </FormField>
        </div>
      </Section>

      <Section title="Alert">
        <div className={styles.stack}>
          {ALERT_VARIANTS.map((variant) => (
            <Alert key={variant} variant={variant} title={`${variant} title`}>
              A short message explaining what happened and what to do next.
            </Alert>
          ))}
          {ALERT_VARIANTS.map((variant) => (
            <Alert key={`no-title-${variant}`} variant={variant}>
              {variant} without a title.
            </Alert>
          ))}
          {ALERT_VARIANTS.map((variant) =>
            dismissed[variant] ? null : (
              <Alert
                key={`dismiss-${variant}`}
                variant={variant}
                title={`Dismissible ${variant}`}
                onDismiss={() => setDismissed((prev) => ({ ...prev, [variant]: true }))}
              >
                Use the close button to dismiss this message.
              </Alert>
            ),
          )}
          {Object.keys(dismissed).length > 0 && (
            <Button size="sm" variant="secondary" onClick={() => setDismissed({})}>
              Restore dismissed alerts
            </Button>
          )}
        </div>
      </Section>

      <Section title="Spinner">
        <div className={styles.row}>
          {SPINNER_SIZES.map((size) => (
            <Spinner key={size} size={size} label={`Loading (${size})`} />
          ))}
        </div>
      </Section>

      <Section title="EmptyState">
        <Card>
          <EmptyState
            icon={
              <svg viewBox="0 0 24 24" width="40" height="40" focusable="false">
                <rect x="4" y="4" width="16" height="16" rx="2" fill="none" stroke="currentColor" strokeWidth="2" />
              </svg>
            }
            title="No assessments yet"
            description="Assessments appear here once an instructor adds them."
            action={<Button>Add assessment</Button>}
          />
        </Card>
        <Card>
          <EmptyState title="Nothing to show" />
        </Card>
      </Section>
    </div>
  );
}
