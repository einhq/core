import type { CSSProperties } from 'react';

/**
 * The explorer's columns — one pane or two, and the tool pane at the right —
 * as styles, so the page bar's tab row can be laid out exactly as the body
 * below it: each pane's tabs stand over that pane, the tools' over the tools.
 *
 * Both rows are the page's full width with no padding of their own, which is
 * what makes a share of the width and the tool pane's `maxWidth` resolve to
 * the same pixels in each.
 */
const SEPARATOR_WIDTH = 6;

export const ROW: CSSProperties = { display: 'flex', minWidth: 0 };

/** The panes together: whatever the tool pane leaves. */
export const PANES: CSSProperties = { display: 'flex', flex: 1, minWidth: 0 };

/** One pane's column; with two, the first takes the stored share of the panes' width. */
export const paneColumn = (index: number, split: boolean, share: number): CSSProperties => ({
  display: 'flex',
  flex: index === 0 && split ? `0 0 calc(100% * ${share})` : 1,
  minWidth: 0,
});

export const toolsColumn = (width: number): CSSProperties => ({ display: 'flex', flex: `0 0 ${width}px`, minWidth: 0, maxWidth: '50%' });

export const separator = (visible: boolean): CSSProperties => ({
  width: SEPARATOR_WIDTH,
  flexShrink: 0,
  ...(visible ? { cursor: 'col-resize', background: 'var(--mantine-color-default-border)', opacity: 0.6 } : {}),
});
