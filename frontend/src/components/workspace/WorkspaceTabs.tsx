import { useId } from 'react';
import type { KeyboardEvent, ReactNode } from 'react';
import { classNames } from '../../utils/classNames';
import styles from './WorkspaceTabs.module.css';

export interface WorkspaceTab<T extends string> {
  id: T;
  label: string;
}

interface WorkspaceTabsProps<T extends string> {
  tabs: Array<WorkspaceTab<T>>;
  active: T;
  onChange: (id: T) => void;
  /** The content of the active tab. It scrolls on its own, so its bottom is always reachable. */
  children: ReactNode;
  label: string;
}

/** Tabs with an obvious active tab (brand underline, bold text) and a panel that scrolls by itself. Arrow keys move between tabs. */
export function WorkspaceTabs<T extends string>({ tabs, active, onChange, children, label }: WorkspaceTabsProps<T>) {
  const base = useId();
  const tabId = (id: string) => `${base}-tab-${id}`;
  const panelId = `${base}-panel`;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const index = tabs.findIndex((tab) => tab.id === active);
    let next = index;
    if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
    else if (event.key === 'ArrowLeft') next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = tabs.length - 1;
    else return;
    event.preventDefault();
    onChange(tabs[next].id);
    document.getElementById(tabId(tabs[next].id))?.focus();
  };

  return (
    <div className={styles.tabs}>
      <div className={styles.list} role="tablist" aria-label={label} onKeyDown={onKeyDown}>
        {tabs.map((tab) => (
          <button
            key={tab.id}
            id={tabId(tab.id)}
            type="button"
            role="tab"
            aria-selected={tab.id === active}
            aria-controls={panelId}
            tabIndex={tab.id === active ? 0 : -1}
            className={classNames(styles.tab, tab.id === active && styles.active)}
            onClick={() => onChange(tab.id)}
          >
            {tab.label}
          </button>
        ))}
      </div>
      <div id={panelId} role="tabpanel" aria-labelledby={tabId(active)} className={styles.panel} tabIndex={0}>
        {children}
      </div>
    </div>
  );
}
