/**
 * What `top` draws with: rows of styled text cut and padded to a width, and the pieces its panels
 * are made of — a framed box with a title, a gauge, an area graph.
 *
 * A row is a list of spans, each a piece of text in one style. Widths are counted in terminal
 * columns, so a row is measured before any escape sequence is added; `toAnsi` adds them last.
 */

import { takeColumns, textWidth } from '../../../../shell/terminal/width.ts';

/** Text in one style: SGR parameters, `''` for the terminal's own colors. */
type Span = { text: string; style: string };

/** One screen row, left to right. */
export type Row = Span[];

/**
 * The palette, as 256-color SGR parameters. The states are the system dashboard's workload
 * colors (completed, queued, running, failed), so a color means the same in both.
 */
export const STYLE = {
  frame: '38;5;240',
  title: '1;38;5;153',
  label: '38;5;246',
  dim: '38;5;243',
  value: '1',
  ok: '38;5;36',
  warn: '38;5;172',
  bad: '38;5;167',
  running: '38;5;68',
  track: '38;5;237',
  key: '1;38;5;153',
  badge: '1;38;5;234;48;5;153',
} as const;

export const span = (text: string, style = ''): Span => ({ text, style });

export const rowWidth = (row: Row): number => row.reduce((sum, part) => sum + textWidth(part.text), 0);

/** Text cut to at most `width` columns from its start, an ellipsis standing in for it: the end of a path. */
export const cutStart = (text: string, width: number): string => {
  if (textWidth(text) <= width) return text;
  if (width <= 0) return '';
  const chars = [...text];
  let out = '';
  let used = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const w = textWidth(chars[i]);
    if (used + w > width - 1) break;
    out = chars[i] + out;
    used += w;
  }
  return '…' + out;
};

/** A row exactly `width` columns wide: padded with blanks, or cut with an ellipsis at the edge. */
export const fit = (row: Row, width: number): Row => {
  if (width <= 0) return [];
  const total = rowWidth(row);
  if (total <= width) return total === width ? row : [...row, span(' '.repeat(width - total))];

  const out: Row = [];
  let left = width;
  for (const part of row) {
    const w = textWidth(part.text);
    if (w < left) {
      out.push(part);
      left -= w;
      continue;
    }
    // This span reaches the edge with more after it, or runs past it: it ends in the ellipsis.
    const kept = takeColumns(part.text, left - 1);
    out.push(span(kept + '…', part.style));
    left -= textWidth(kept) + 1;
    break;
  }
  if (left > 0) out.push(span(' '.repeat(left)));
  return out;
};

/** A row in `width` columns: `left` from the start, `right` against the end, blanks between; `left` gives way. */
export const spread = (left: Row, right: Row, width: number): Row => {
  const rightWidth = Math.min(rowWidth(right), width);
  const leftPart = fit(left, Math.max(0, width - rightWidth - (rightWidth > 0 ? 1 : 0)));
  const gap = width - rowWidth(leftPart) - rightWidth;
  return [...leftPart, span(' '.repeat(Math.max(0, gap))), ...fit(right, rightWidth)];
};

/** Text padded to `width` on the left, for numbers in a column. */
export const padStart = (text: string, width: number): string => ' '.repeat(Math.max(0, width - textWidth(text))) + text;

/** Text padded to `width` on the right. */
export const padEnd = (text: string, width: number): string => text + ' '.repeat(Math.max(0, width - textWidth(text)));

/** A row as the terminal draws it, each span in its own style and the terminal's own after. */
export const toAnsi = (row: Row): string => {
  let out = '';
  let current = '';
  for (const part of row) {
    if (!part.text) continue;
    if (part.style !== current) {
      out += `\x1b[0${part.style ? ';' + part.style : ''}m`;
      current = part.style;
    }
    out += part.text;
  }
  return current ? `${out}\x1b[0m` : out;
};

/** A row's text alone, for a frame written where colors mean nothing. */
export const toText = (row: Row): string => row.map((part) => part.text).join('');

/** The color of a share of a ceiling, in the dashboard's bands: 75% is high, 90% critical. */
export const bandStyle = (percent: number | undefined): string => (percent ?? 0) >= 90 ? STYLE.bad : (percent ?? 0) >= 75 ? STYLE.warn : STYLE.ok;

const clamp01 = (value: number): number => Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));

/** Eighths of a cell, left to right. */
const PARTIAL = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];

/** A bar `width` columns long, filled to `fraction` in eighths of a column, the rest a faint track. */
export const gauge = (fraction: number, width: number, style: string): Row => {
  if (width <= 0) return [];
  const eighths = Math.round(clamp01(fraction) * width * 8);
  const full = Math.floor(eighths / 8);
  const part = PARTIAL[eighths % 8];
  const filled = '█'.repeat(full) + part;
  const used = full + (part ? 1 : 0);
  return [span(filled, style), span('░'.repeat(width - used), STYLE.track)];
};

/** Eighths of a cell, bottom up. */
const LEVELS = [' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/**
 * Values from 0 to 1, oldest first, as a filled area `width` columns by `height` rows with the
 * newest value against the right edge. Each row takes its color from how high up it is, so the
 * top of a tall peak is drawn hot. A value above zero shows at least an eighth.
 */
export const areaGraph = (values: number[], width: number, height: number, styleAt: (fraction: number) => string): Row[] => {
  const shown = values.slice(-width);
  const blank = ' '.repeat(Math.max(0, width - shown.length));
  const heights = shown.map((value) => value > 0 ? Math.max(1, Math.round(clamp01(value) * height * 8)) : 0);
  const rows: Row[] = [];
  for (let level = height - 1; level >= 0; level--) {
    const cells = heights.map((eighths) => LEVELS[Math.max(0, Math.min(8, eighths - level * 8))]).join('');
    rows.push([span(blank + cells, styleAt((level + 0.5) / height))]);
  }
  return rows;
};

/** Green at the bottom of a graph through amber to red at the top, turning where the bands do. */
export const heatStyle = (fraction: number): string => {
  if (fraction >= 0.9) return '38;5;167';
  if (fraction >= 0.83) return '38;5;173';
  if (fraction >= 0.75) return '38;5;179';
  if (fraction >= 0.65) return '38;5;143';
  if (fraction >= 0.5) return '38;5;107';
  if (fraction >= 0.25) return '38;5;72';
  return '38;5;36';
};

/** Columns a box's content has, inside its frame and the blank either side. */
export const boxInner = (width: number): number => Math.max(0, width - 4);

/**
 * A panel: a rounded frame `width` by `height` with `title` on the top edge, `info` at its right,
 * and `footer` at the right of the bottom edge. The content is cut and padded to the inside, a
 * blank from the frame on either side; what does not fit below is dropped.
 */
export const box = (title: Row, info: Row, content: Row[], width: number, height: number, footer: Row = []): Row[] => {
  if (width < 4 || height < 2) return Array.from({ length: Math.max(0, height) }, () => fit([], width));
  const inner = width - 2;
  const edge = (left: string, labels: Row, right: Row, end: string): Row => {
    // `─ title ─────── info ─`: each label keeps a dash and a blank either side, or is left off.
    const rightPart = right.length && rowWidth(right) + 4 <= inner ? [span(' '), ...right, span(' ')] : [];
    const room = inner - rowWidth(rightPart) - (rightPart.length ? 1 : 0);
    const leftPart = labels.length && room >= 5 ? [span(' '), ...fit(labels, Math.min(rowWidth(labels), room - 3)), span(' ')] : [];
    const dashes = inner - 1 - rowWidth(leftPart) - rowWidth(rightPart) - (rightPart.length ? 1 : 0);
    return [
      span(left + (leftPart.length ? '─' : ''), STYLE.frame),
      ...leftPart,
      span('─'.repeat(Math.max(0, dashes + (leftPart.length ? 0 : 1))), STYLE.frame),
      ...rightPart,
      span((rightPart.length ? '─' : '') + end, STYLE.frame),
    ];
  };
  const rows: Row[] = [edge('╭', title.map((part) => part.style ? part : span(part.text, STYLE.title)), info, '╮')];
  for (let i = 0; i < height - 2; i++) {
    rows.push([span('│ ', STYLE.frame), ...fit(content[i] ?? [], boxInner(width)), span(' │', STYLE.frame)]);
  }
  rows.push(edge('╰', [], footer, '╯'));
  return rows;
};
