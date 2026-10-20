import { cloneElement, useId } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { classNames } from '../../utils/classNames';
import styles from './FormField.module.css';

/** Props FormField injects into its control. Input, Textarea and Select all accept these. */
interface FieldControlProps {
  id?: string;
  'aria-describedby'?: string;
  'aria-invalid'?: boolean;
  'aria-required'?: boolean;
}

export interface FormFieldProps {
  label: string;
  /** Exactly one control: <Input />, <Textarea />, <Select />, or a native equivalent. */
  children: ReactElement<FieldControlProps>;
  hint?: ReactNode;
  /** When set, the control is marked invalid and the message is announced. */
  error?: ReactNode;
  required?: boolean;
  /** Override the generated control id. */
  id?: string;
  className?: string;
}

export function FormField({ label, children, hint, error, required, id, className }: FormFieldProps) {
  const generatedId = useId();
  const controlId = id ?? children.props.id ?? generatedId;
  const hintId = `${controlId}-hint`;
  const errorId = `${controlId}-error`;

  const hasHint = hint !== undefined && hint !== null && hint !== false;
  const hasError = error !== undefined && error !== null && error !== false && error !== '';

  const describedBy =
    [children.props['aria-describedby'], hasHint ? hintId : undefined, hasError ? errorId : undefined]
      .filter(Boolean)
      .join(' ') || undefined;

  const control = cloneElement(children, {
    id: controlId,
    'aria-describedby': describedBy,
    'aria-invalid': hasError ? true : children.props['aria-invalid'],
    'aria-required': required ? true : children.props['aria-required'],
  });

  return (
    <div className={classNames(styles.field, className)}>
      <label htmlFor={controlId} className={styles.label}>
        {label}
        {required && <span className={styles.required}> (required)</span>}
      </label>
      {control}
      {hasHint && (
        <p id={hintId} className={styles.hint}>
          {hint}
        </p>
      )}
      {hasError && (
        <p id={errorId} className={styles.error} role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
