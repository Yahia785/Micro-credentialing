import { useRef, useState } from 'react';
import type { CSSProperties, KeyboardEvent, PointerEvent, ReactNode } from 'react';
import styles from './SplitPane.module.css';

interface SplitPaneProps {
  left: ReactNode;
  right: ReactNode;
  /** Accessible name of the divider. */
  dividerLabel?: string;
  /** Share of the width the left pane starts with, from 0 to 1. */
  initialRatio?: number;
  /** Smallest width of each pane in pixels. */
  minLeft?: number;
  minRight?: number;
  /** Hides the left pane and its divider; the right pane takes the full width. */
  hideLeft?: boolean;
}

const KEY_STEP = 0.03;

/**
 * Two panes side by side with a draggable divider (pointer or arrow keys). Each pane fills the full height and scrolls on its
 * own. On narrow screens the panes stack and the divider is hidden.
 */
export function SplitPane({
  left,
  right,
  dividerLabel = 'Resize panels',
  initialRatio = 0.5,
  minLeft = 320,
  minRight = 360,
  hideLeft = false,
}: SplitPaneProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [ratio, setRatio] = useState(initialRatio);
  const [dragging, setDragging] = useState(false);

  /** Keeps both panes at least their minimum width (when the window is wide enough for both). */
  const clamp = (value: number) => {
    const width = containerRef.current?.getBoundingClientRect().width ?? 0;
    if (width <= 0) return value;
    const low = Math.min(minLeft / width, 0.5);
    const high = Math.max(1 - minRight / width, 0.5);
    return Math.min(Math.max(value, low), high);
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    const box = containerRef.current?.getBoundingClientRect();
    if (!box || box.width <= 0) return;
    setRatio(clamp((event.clientX - box.left) / box.width));
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'ArrowLeft') setRatio((value) => clamp(value - KEY_STEP));
    else if (event.key === 'ArrowRight') setRatio((value) => clamp(value + KEY_STEP));
    else if (event.key === 'Home') setRatio(clamp(0));
    else if (event.key === 'End') setRatio(clamp(1));
    else return;
    event.preventDefault();
  };

  // The one dynamic value: the width the user dragged to.
  const style = { '--split-left': `${ratio * 100}%` } as CSSProperties;

  // The left pane is only hidden, never removed, so the right pane keeps its place in the tree (and its scroll position and text).
  return (
    <div ref={containerRef} className={hideLeft ? `${styles.split} ${styles.alone}` : styles.split} style={style}>
      <div className={styles.pane} hidden={hideLeft}>
        {left}
      </div>
      <div
        className={dragging ? `${styles.divider} ${styles.dragging}` : styles.divider}
        role="separator"
        aria-orientation="vertical"
        aria-label={dividerLabel}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(ratio * 100)}
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={() => setDragging(false)}
        onPointerCancel={() => setDragging(false)}
        onKeyDown={onKeyDown}
        hidden={hideLeft}
      />
      <div className={styles.pane}>{right}</div>
    </div>
  );
}
