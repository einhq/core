import { highlightRanges as highlightTokens } from '@ein/highlight';
import { type ReactNode, useMemo } from 'react';

/**
 * Fence names as the documentation writes them: no name, `sh`, `bash` and `console` are EiN command
 * lines, so the command an example runs stands out. Any other name is the shared highlighter's.
 */
const COMMAND_LINE = new Set(['', 'sh', 'bash', 'shell', 'console']);

/** The text cut into runs, each with the `mrx-tok-*` classes of its kinds, if any. Pure, so it is tested directly. */
export const highlightRanges = (code: string, language: string): { text: string; className?: string }[] =>
  highlightTokens(code, COMMAND_LINE.has(language.trim().toLowerCase()) ? 'command-line' : language).map((range) =>
    range.kinds ? { text: range.text, className: range.kinds.map((kind) => `mrx-tok-${kind}`).join(' ') } : { text: range.text }
  );

const highlight = (code: string, language: string): ReactNode[] =>
  highlightRanges(code, language).map((range, i) => range.className ? <span key={i} className={range.className}>{range.text}</span> : range.text);

export type HighlightedCodeProps = {
  code: string;
  /** A fence name (`sh`, `json`, `yaml`…). None is a command line; a name it does not know is plain text. */
  language?: string;
  /** Inline in running text rather than a block of its own. */
  inline?: boolean;
};

/**
 * Code coloured the way the editor colours it, without an editor: the language's parser run
 * once and the result drawn as spans. A page of three hundred command examples cannot afford
 * an `EditorView` apiece.
 */
export function HighlightedCode({ code, language = '', inline = false }: HighlightedCodeProps) {
  const spans = useMemo(() => highlight(code, language), [code, language]);
  if (inline) return <code className='mrx-code mrx-code-inline'>{spans}</code>;
  return (
    <pre className='mrx-code mrx-code-block'>
      <code>{spans}</code>
    </pre>
  );
}
