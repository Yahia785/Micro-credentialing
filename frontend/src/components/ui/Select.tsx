import type { ComponentPropsWithRef } from 'react';
import { classNames } from '../../utils/classNames';
import styles from './Select.module.css';

export interface SelectProps extends ComponentPropsWithRef<'select'> {
  invalid?: boolean;
}

export function Select({ invalid, className, children, ...rest }: SelectProps) {
  return (
    <select
      {...rest}
      aria-invalid={invalid || rest['aria-invalid']}
      className={classNames(styles.select, className)}
    >
      {children}
    </select>
  );
}
