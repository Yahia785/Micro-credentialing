import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { classNames } from '../../utils/classNames';
import styles from './MarkdownText.module.css';

interface MarkdownTextProps {
  /** Markdown or plain text. Raw HTML in it is shown as text, never rendered. */
  children: string;
  className?: string;
}

const REMARK_PLUGINS = [remarkGfm];

// Links open in a new tab and cannot reach back into this page.
const COMPONENTS: Components = {
  a: ({ href, title, children }) => (
    <a href={href} title={title} target="_blank" rel="noopener noreferrer">
      {children}
    </a>
  ),
};

/**
 * Problem descriptions and other instructor-written text. Headings, bold, lists, tables, inline code and code
 * blocks are styled for reading; a plain-text description keeps its line breaks and looks as it did before.
 */
export function MarkdownText({ children, className }: MarkdownTextProps) {
  return (
    <div className={classNames(styles.markdown, className)}>
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={COMPONENTS}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
