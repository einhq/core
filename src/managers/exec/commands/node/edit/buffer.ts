/**
 * The editor's text: lines, a cursor, and undo. Columns are UTF-16 indices into a line; the
 * cursor steps over a surrogate pair as one character.
 */

export type Pos = { line: number; col: number };

type Snapshot = { lines: string[]; cursor: Pos; version: number };

/** Edits that follow one another of the same kind undo together: a typed word, a run of deletes. */
type EditKind = 'type' | 'delete' | 'other';

const UNDO_LIMIT = 200;
/** A pause longer than this ends a run of typing or deleting. */
const RUN_PAUSE_MS = 500;
const WORD = /[\p{L}\p{N}_]/u;

const isHigh = (code: number) => code >= 0xd800 && code <= 0xdbff;
const isLow = (code: number) => code >= 0xdc00 && code <= 0xdfff;

/**
 * The unit one Tab inserts: a tab when the text indents with tabs (or must, as a Makefile does),
 * otherwise the smallest indent of two or more spaces it has, and two spaces when it has none.
 */
export function detectIndent(lines: string[], tabs = false): string {
  if (tabs) return '\t';
  let tabbed = 0;
  let spaced = 0;
  let smallest = Infinity;
  for (const line of lines) {
    if (line.startsWith('\t')) tabbed++;
    const spaces = /^ +(?=\S)/.exec(line)?.[0].length ?? 0;
    if (spaces > 0) spaced++;
    if (spaces >= 2 && spaces < smallest) smallest = spaces;
  }
  if (tabbed > spaced) return '\t';
  return ' '.repeat(smallest === Infinity ? 2 : Math.min(smallest, 8));
}

export class TextBuffer {
  lines: string[];
  cursor: Pos = { line: 0, col: 0 };
  /** Changes with every edit and comes back with undo: equal versions are equal texts. */
  version = 0;
  readonly indentUnit: string;

  private nextVersion = 1;
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private lastKind: EditKind | undefined;
  private lastEdit = 0;
  private readonly now: () => number;

  constructor(text: string, opts: { indentWithTabs?: boolean; now?: () => number } = {}) {
    this.lines = text.split('\n');
    this.indentUnit = detectIndent(this.lines, opts.indentWithTabs);
    this.now = opts.now ?? Date.now;
  }

  get text(): string {
    return this.lines.join('\n');
  }

  get line(): string {
    return this.lines[this.cursor.line];
  }

  // --- Undo -------------------------------------------------------------------------------

  /** Records the state before an edit, unless the edit continues a run of the same kind without a pause. */
  private begin(kind: EditKind) {
    const now = this.now();
    const continues = kind !== 'other' && kind === this.lastKind && now - this.lastEdit <= RUN_PAUSE_MS;
    this.lastEdit = now;
    if (!continues) {
      this.undoStack.push({ lines: [...this.lines], cursor: { ...this.cursor }, version: this.version });
      if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    }
    this.redoStack = [];
    this.lastKind = kind;
    this.version = this.nextVersion++;
  }

  /** Ends the current run of typing or deleting: the next edit undoes on its own. */
  breakRun() {
    this.lastKind = undefined;
  }

  private restore(from: Snapshot[], to: Snapshot[]): boolean {
    const snapshot = from.pop();
    if (!snapshot) return false;
    to.push({ lines: [...this.lines], cursor: { ...this.cursor }, version: this.version });
    this.lines = snapshot.lines;
    this.cursor = snapshot.cursor;
    this.version = snapshot.version;
    this.lastKind = undefined;
    return true;
  }

  undo(): boolean {
    return this.restore(this.undoStack, this.redoStack);
  }

  redo(): boolean {
    return this.restore(this.redoStack, this.undoStack);
  }

  // --- Edits ------------------------------------------------------------------------------

  private insertRaw(text: string) {
    const { line, col } = this.cursor;
    const current = this.lines[line];
    const parts = text.split('\n');
    const before = current.slice(0, col);
    const after = current.slice(col);
    if (parts.length === 1) {
      this.lines[line] = before + text + after;
      this.cursor = { line, col: col + text.length };
      return;
    }
    const last = parts[parts.length - 1];
    // Not splice: a pasted text can have more lines than a call takes arguments.
    this.lines = this.lines.slice(0, line).concat([before + parts[0]], parts.slice(1, -1), [last + after], this.lines.slice(line + 1));
    this.cursor = { line: line + parts.length - 1, col: last.length };
  }

  /** Typed text; a word typed in one go undoes as one. */
  type(text: string) {
    this.begin(/^\s/.test(text) ? 'other' : 'type');
    this.insertRaw(text);
  }

  /** Pasted text, as it is, undone as one. */
  paste(text: string) {
    if (!text) return;
    this.begin('other');
    this.insertRaw(text);
  }

  /** Splits the line at the cursor; the new line starts with the indent of the one it came from. */
  newline() {
    this.begin('other');
    const { line, col } = this.cursor;
    const current = this.lines[line];
    let before = current.slice(0, col);
    const indent = /^[\t ]*/.exec(current)![0].slice(0, col);
    // A line left holding only its indent is left empty.
    if (/^[\t ]+$/.test(before)) before = '';
    this.lines.splice(line, 1, before, indent + current.slice(col).replace(/^[\t ]+/, ''));
    this.cursor = { line: line + 1, col: indent.length };
  }

  indent() {
    this.begin('other');
    this.insertRaw(this.indentUnit);
  }

  backspace() {
    const { line, col } = this.cursor;
    if (col === 0 && line === 0) return;
    this.begin('delete');
    if (col === 0) {
      const previous = this.lines[line - 1];
      this.lines.splice(line - 1, 2, previous + this.lines[line]);
      this.cursor = { line: line - 1, col: previous.length };
      return;
    }
    const from = this.charBefore(line, col);
    this.lines[line] = this.lines[line].slice(0, from) + this.lines[line].slice(col);
    this.cursor = { line, col: from };
  }

  deleteForward() {
    const { line, col } = this.cursor;
    const current = this.lines[line];
    if (col >= current.length && line >= this.lines.length - 1) return;
    this.begin('delete');
    if (col >= current.length) {
      this.lines.splice(line, 2, current + this.lines[line + 1]);
      return;
    }
    this.lines[line] = current.slice(0, col) + current.slice(this.charAfter(line, col));
  }

  /** Removes the cursor's line and returns it, newline included. */
  cutLine(): string {
    this.begin('other');
    const { line } = this.cursor;
    const removed = this.lines[line];
    if (this.lines.length === 1) this.lines[0] = '';
    else this.lines.splice(line, 1);
    this.cursor = { line: Math.min(line, this.lines.length - 1), col: 0 };
    return removed + '\n';
  }

  // --- Moves ------------------------------------------------------------------------------

  private charBefore(line: number, col: number): number {
    const text = this.lines[line];
    return col >= 2 && isLow(text.charCodeAt(col - 1)) && isHigh(text.charCodeAt(col - 2)) ? col - 2 : col - 1;
  }

  private charAfter(line: number, col: number): number {
    const text = this.lines[line];
    return isHigh(text.charCodeAt(col)) && isLow(text.charCodeAt(col + 1)) ? col + 2 : col + 1;
  }

  /** Puts the cursor at a position, clamped into the text and off the middle of a surrogate pair. */
  moveTo(pos: Pos) {
    this.breakRun();
    const line = Math.max(0, Math.min(pos.line, this.lines.length - 1));
    const text = this.lines[line];
    let col = Math.max(0, Math.min(pos.col, text.length));
    if (col > 0 && isLow(text.charCodeAt(col)) && isHigh(text.charCodeAt(col - 1))) col--;
    this.cursor = { line, col };
  }

  left() {
    const { line, col } = this.cursor;
    if (col > 0) this.moveTo({ line, col: this.charBefore(line, col) });
    else if (line > 0) this.moveTo({ line: line - 1, col: this.lines[line - 1].length });
  }

  right() {
    const { line, col } = this.cursor;
    if (col < this.lines[line].length) this.moveTo({ line, col: this.charAfter(line, col) });
    else if (line < this.lines.length - 1) this.moveTo({ line: line + 1, col: 0 });
  }

  /** To the start of the word before the cursor, across line ends. */
  wordLeft() {
    let { line, col } = this.cursor;
    if (col === 0) {
      if (line === 0) return;
      line--;
      col = this.lines[line].length;
    }
    const text = this.lines[line];
    while (col > 0 && !WORD.test(text[col - 1])) col--;
    while (col > 0 && WORD.test(text[col - 1])) col--;
    this.moveTo({ line, col });
  }

  /** To the end of the word after the cursor, across line ends. */
  wordRight() {
    let { line, col } = this.cursor;
    if (col >= this.lines[line].length) {
      if (line >= this.lines.length - 1) return;
      line++;
      col = 0;
    }
    const text = this.lines[line];
    while (col < text.length && !WORD.test(text[col])) col++;
    while (col < text.length && WORD.test(text[col])) col++;
    this.moveTo({ line, col });
  }

  /** To the first non-blank character, or to the line's start when already there. */
  home() {
    const indent = /^[\t ]*/.exec(this.line)![0].length;
    this.moveTo({ line: this.cursor.line, col: this.cursor.col === indent ? 0 : indent });
  }

  end() {
    this.moveTo({ line: this.cursor.line, col: this.line.length });
  }

  /** The next match of a text after the cursor, ignoring case and wrapping past the end. */
  find(needle: string): { pos: Pos; wrapped: boolean } | undefined {
    if (!needle) return undefined;
    const lower = needle.toLowerCase();
    const count = this.lines.length;
    for (let step = 0; step <= count; step++) {
      const line = (this.cursor.line + step) % count;
      const from = step === 0 ? this.cursor.col + 1 : 0;
      const col = this.lines[line].toLowerCase().indexOf(lower, from);
      // Back on the cursor's line after wrapping, only a match at or before the cursor is new.
      if (col >= 0 && (step < count || col <= this.cursor.col)) return { pos: { line, col }, wrapped: this.cursor.line + step >= count };
    }
    return undefined;
  }
}
