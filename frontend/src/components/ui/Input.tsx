import type { ComponentPropsWithRef } from 'react';
import { classNames } from '../../utils/classNames';
import styles from './Input.module.css';

export interface InputProps extends ComponentPropsWithRef<'input'> {
  /** Marks the field invalid (sets aria-invalid). FormField does this for you from its `error`. */
  invalid?: boolean;
}

export function Input({ invalid, className, ...rest }: InputProps) {
  return (
    <input
      {...rest}
      aria-invalid={invalid || rest['aria-invalid']}
      className={classNames(styles.field, className)}
    />
  );
}
