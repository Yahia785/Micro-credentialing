import type { ComponentPropsWithRef } from 'react';
import { classNames } from '../../utils/classNames';
import styles from './Textarea.module.css';

export interface TextareaProps extends ComponentPropsWithRef<'textarea'> {
  invalid?: boolean;
}

export function Textarea({ invalid, className, rows = 4, ...rest }: TextareaProps) {
  return (
    <textarea
      rows={rows}
      {...rest}
      aria-invalid={invalid || rest['aria-invalid']}
      className={classNames(styles.textarea, className)}
    />
  );
}
