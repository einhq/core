/**
 * The editor on the terminal: lines laid out as cells (tabs expanded, wide characters two
 * columns), wrapped or scrolled sideways, with a gutter, a status bar and a help or prompt row.
 * `Screen` writes only the rows that changed since the last frame.
 */

import type { Run, StyledLine } from '../../../../shell/terminal/syntax.ts';
import { codePointWidth } from '../../../../shell/terminal/width.ts';
import type { Pos } from './buffer.ts';
import type { Problem } from './check.ts';

const TAB_WIDTH = 4;

/** One character as drawn: the UTF-16 range it covers in its line, what is drawn and how wide. */
export type Cell = { start: number; end: number; text: string; width: number };

/** A screen row of a wrapped line: cells `[from, to)`. A line that does not wrap is one segment. */
export type Segment = { from: number; to: number };

/** A line as cells. Tabs reach the next tab stop; other control characters show as `^X`. */
export function layoutLine(line: string): Cell[] {
  const cells: Cell[] = [];
  let column = 0;
  for (let i = 0; i < line.length;) {
    const code = line.codePointAt(i)!;
    const length = code > 0xffff ? 2 : 1;
    let text = line.slice(i, i + length);
    let width: number;
    if (code === 9) {
      width = TAB_WIDTH - (column % TAB_WIDTH);
      text = ' '.repeat(width);
    } else if (code < 0x20 || code === 0x7f) {
      text = '^' + String.fromCharCode(code === 0x7f ? 63 : code + 64);
      width = 2;
    } else {
      width = codePointWidth(code);
    }
    cells.push({ start: i, end: i + length, text, width });
    column += width;
    i += length;
  }
  return cells;
}

/** The display column of a UTF-16 index in a line's cells. */
export function displayColumn(cells: Cell[], col: number): number {
  let x = 0;
  for (const cell of cells) {
    if (cell.start >= col) break;
    x += cell.width;
  }
  return x;
}

/** The index of the cell at or after a display column, from cell `from` up to cell `to`. */
export function cellAt(cells: Cell[], x: number, from = 0, to = cells.length): number {
  let width = 0;
  for (let i = from; i < to; i++) {
    if (width + cells[i].width > x) return i;
    width += cells[i].width;
  }
  return to;
}

/** The UTF-16 index a cell index stands for, the line's end past the last cell. */
export const cellStart = (cells: Cell[], index: number, line: string): number => (index < cells.length ? cells[index].start : line.length);

/** A line's cells cut into rows of at most `width` columns, at the last space where one fits. */
export function wrapSegments(cells: Cell[], width: number): Segment[] {
  const segments: Segment[] = [];
  let from = 0;
  while (from < cells.length) {
    let used = 0;
    let to = from;
    let lastSpace = -1;
    while (to < cells.length && (used + cells[to].width <= width || to === from)) {
      used += cells[to].width;
      if (/^\s+$/.test(cells[to].text)) lastSpace = to;
      to++;
    }
    if (to < cells.length && lastSpace >= from && lastSpace + 1 < to) to = lastSpace + 1;
    segments.push({ from, to });
    from = to;
  }
  if (segments.length === 0) segments.push({ from: 0, to: 0 });
  return segments;
}

/** The segment a cell index falls in; the cursor at the end of a segment belongs to the next one. */
export function segmentOf(segments: Segment[], cell: number): number {
  for (let i = 0; i < segments.length; i++) {
    if (cell < segments[i].to) return i;
  }
  return segments.length - 1;
}

/** Columns the gutter takes: a problem mark, the line number, a space. */
export const gutterWidth = (lineCount: number): number => String(lineCount).length + 2;

type View = {
  rows: number;
  cols: number;
  lines: string[];
  styled?: StyledLine[];
  problems: Problem[];
  cursor: Pos;
  /** The first line shown, and its first segment shown when wrapping. */
  top: { line: number; segment: number };
  /** Columns scrolled sideways when not wrapping. */
  left: number;
  wrap: boolean;
  statusLeft: Run[];
  statusRight: Run[];
  bottom: Run[];
  /** The cursor's column on the bottom row while a prompt is open. */
  promptCursor?: number;
};

type Frame = { rows: string[]; cursor: { row: number; col: number } };

const PROBLEM_STYLE = '4;31';
const END_PROBLEM_STYLE = '41';
const GUTTER_STYLE = '90';
const MARK_STYLE = '1;31';
const STATUS_STYLE = '7';

const sgr = (style: string) => `\x1b[0${style ? ';' + style : ''}m`;

/** Runs as one row of at most `width` columns, with how many columns it took; a run without a style of its own takes `base`. */
function fitRuns(runs: Run[], width: number, base = ''): { text: string; width: number } {
  let out = '';
  let used = 0;
  for (const run of runs) {
    out += sgr(run.style || base);
    for (const char of run.text) {
      const w = codePointWidth(char.codePointAt(0)!);
      if (used + w > width) return { text: out, width: used };
      out += char;
      used += w;
    }
  }
  return { text: out, width: used };
}

/** The style of each UTF-16 index of a line. */
function stylesOf(line: string, styled: StyledLine | undefined): string[] {
  const styles: string[] = new Array(line.length).fill('');
  let i = 0;
  for (const run of styled ?? []) {
    for (let j = 0; j < run.text.length && i < line.length; j++) styles[i++] = run.style;
  }
  return styles;
}

/** One text row: a line's cells `[from, to)` from display column `skip`, at most `width` wide. */
function textRow(cells: Cell[], from: number, to: number, skip: number, width: number, styles: string[], marks: Set<number>, endMark: boolean): string {
  let out = '';
  let used = 0;
  let x = 0;
  let current: string | undefined;
  const put = (text: string, style: string) => {
    if (style !== current) {
      out += sgr(style);
      current = style;
    }
    out += text;
  };
  for (let i = from; i < to && used < width; i++) {
    const cell = cells[i];
    const style = marks.has(cell.start) ? [styles[cell.start], PROBLEM_STYLE].filter(Boolean).join(';') : styles[cell.start] ?? '';
    if (x < skip) {
      // A wide character cut by the left edge shows as blanks.
      const shown = x + cell.width - skip;
      if (shown > 0) {
        put(' '.repeat(shown), style);
        used += shown;
      }
      x += cell.width;
      continue;
    }
    x += cell.width;
    if (used + cell.width > width) {
      put(' '.repeat(width - used), '');
      used = width;
      break;
    }
    put(cell.text, style);
    used += cell.width;
  }
  // The mark past the end shows only where the line's end is in view.
  if (endMark && used < width && x >= skip) {
    put(' ', END_PROBLEM_STYLE);
    used++;
  }
  return out + sgr('') + (used < width ? '\x1b[K' : '');
}

/** The view as screen rows and where the cursor goes. */
export function render(view: View): Frame {
  const { rows, cols, lines } = view;
  const textRows = Math.max(1, rows - 2);
  const gutter = gutterWidth(lines.length);
  const width = Math.max(1, cols - gutter);
  const problemLines = new Map<number, Problem[]>();
  for (const problem of view.problems) {
    const list = problemLines.get(problem.line - 1) ?? [];
    list.push(problem);
    problemLines.set(problem.line - 1, list);
  }

  const out: string[] = [];
  let cursor = { row: 0, col: gutter };
  let line = view.top.line;
  let segment = view.top.segment;
  while (out.length < textRows) {
    if (line >= lines.length) {
      out.push(sgr(GUTTER_STYLE) + '~' + sgr('') + '\x1b[K');
      continue;
    }
    const text = lines[line];
    const cells = layoutLine(text);
    const segments = view.wrap ? wrapSegments(cells, width) : [{ from: 0, to: cells.length }];
    const styles = stylesOf(text, view.styled?.[line]);
    const problems = problemLines.get(line) ?? [];
    const marks = new Set(problems.filter((p) => p.col !== undefined && p.col - 1 < text.length).map((p) => p.col! - 1));
    // A column the parser names inside a character marks that character.
    for (const mark of [...marks]) {
      const cell = cells.find((c) => c.start <= mark && mark < c.end);
      if (cell && cell.start !== mark) marks.add(cell.start);
    }
    const endMark = problems.some((p) => p.col !== undefined && p.col - 1 >= text.length);
    const cursorCell = line === view.cursor.line ? cells.findIndex((c) => c.start >= view.cursor.col) : -1;
    const cursorSegment = cursorCell === -1 ? segments.length - 1 : segmentOf(segments, cursorCell);

    for (; segment < segments.length && out.length < textRows; segment++) {
      const { from, to } = segments[segment];
      const number = segment === 0 ? String(line + 1).padStart(gutter - 2) : ' '.repeat(gutter - 2);
      const mark = segment === 0 && problems.length > 0 ? sgr(MARK_STYLE) + '✗' : ' ';
      const numberStyle = line === view.cursor.line ? '' : GUTTER_STYLE;
      const isLast = segment === segments.length - 1;
      const skip = view.wrap ? 0 : view.left;
      out.push(mark + sgr(numberStyle) + number + ' ' + textRow(cells, from, to, skip, width, styles, marks, endMark && isLast));
      if (line === view.cursor.line && segment === cursorSegment) {
        const x = displayColumn(cells, view.cursor.col) - displayColumn(cells, cellStart(cells, from, text)) - skip;
        cursor = { row: out.length - 1, col: gutter + Math.max(0, Math.min(x, width - 1)) };
      }
    }
    line++;
    segment = 0;
  }

  // The position on the right stays whole; a long message on the left is cut.
  const right = fitRuns(view.statusRight, cols, STATUS_STYLE);
  const left = fitRuns(view.statusLeft, Math.max(0, cols - right.width - 1), STATUS_STYLE);
  out.push(left.text + sgr(STATUS_STYLE) + ' '.repeat(Math.max(0, cols - left.width - right.width)) + right.text + sgr(''));
  // One column short of the edge: a full last row leaves some terminals about to scroll.
  const bottom = fitRuns(view.bottom, Math.max(0, cols - 1));
  out.push(bottom.text + sgr('') + '\x1b[K');

  if (view.promptCursor !== undefined) cursor = { row: rows - 1, col: Math.min(view.promptCursor, cols - 1) };
  return { rows: out, cursor };
}

/** Draws frames, writing only the rows that differ from the previous one. */
export class Screen {
  private previous: string[] = [];
  private queue: Promise<void> = Promise.resolve();

  constructor(private write: (data: string) => Promise<void>) {}

  /** Forgets what is on the screen, so the next frame is drawn whole. */
  invalidate() {
    this.previous = [];
  }

  /** Draws a frame; frames are written in order, one write each. */
  draw(frame: Frame): Promise<void> {
    let out = '\x1b[?25l';
    if (this.previous.length === 0) out += '\x1b[0m\x1b[2J';
    frame.rows.forEach((row, i) => {
      if (row !== this.previous[i]) out += `\x1b[${i + 1};1H${row}`;
    });
    out += `\x1b[${frame.cursor.row + 1};${frame.cursor.col + 1}H\x1b[?25h`;
    this.previous = frame.rows;
    this.queue = this.queue.then(() => this.write(out));
    return this.queue;
  }
}
