/**
 * The editor: keys in, frames out. It holds the text, highlights and checks it after each chunk of
 * input that changed it, and asks before quitting with unsaved changes or saving a text with
 * syntax errors. Reading the file, writing it and the terminal are the caller's.
 */

import { highlightLines, type Run, type StyledLine } from '../../../../shell/terminal/syntax.ts';
import { TextBuffer } from './buffer.ts';
import { check, isCheckable, type Problem } from './check.ts';
import { type Key, KeyReader } from '../../../../shell/terminal/keys.ts';
import { textWidth } from '../../../../shell/terminal/width.ts';
import { type Cell, cellAt, cellStart, displayColumn, gutterWidth, layoutLine, render, Screen, type Segment, segmentOf, wrapSegments } from './screen.ts';

type EditorOptions = {
  text: string;
  /** The file's name, for the status bar. */
  name: string;
  /** The text's language, given its first line: a script typed into a new file can name its own. */
  language: (firstLine: string) => string | undefined;
  isNew: boolean;
  rows: number;
  cols: number;
  save: (text: string) => Promise<void>;
  write: (data: string) => Promise<void>;
  /** The clock, in milliseconds, that times checks and runs of typing. */
  now?: () => number;
};

type Prompt =
  | { kind: 'find' | 'goto'; label: string; input: string }
  | { kind: 'quit'; label: string }
  | { kind: 'save-anyway'; label: string; thenQuit: boolean };

const LANGUAGE_NAMES: Record<string, string> = {
  json: 'JSON',
  jsonc: 'JSONC',
  yaml: 'YAML',
  bash: 'bash',
  markdown: 'Markdown',
  typescript: 'TypeScript',
  javascript: 'JavaScript',
  python: 'Python',
  xml: 'XML',
  css: 'CSS',
  makefile: 'Makefile',
};

const HELP: [string, string][] = [['^S', 'Save'], ['^Q', 'Quit'], ['^F', 'Find'], ['^G', 'Line'], ['^Z', 'Undo'], ['^Y', 'Redo'], ['^K', 'Cut'], ['^U', 'Paste']];

const ERROR_STYLE = '41;97';

/** A check that took longer than this waits for a pause in typing instead of running on every change. */
const LIVE_CHECK_MS = 50;
/** How long typing must pause before a slow check runs. */
const CHECK_PAUSE_MS = 500;

const describe = (problem: Problem) => `✗ ${problem.line}${problem.col !== undefined ? ':' + problem.col : ''} ${problem.message}`;

export class Editor {
  readonly buffer: TextBuffer;
  private rows: number;
  private cols: number;
  private readonly screen: Screen;
  private readonly keys = new KeyReader();
  private lang: string | undefined;
  private firstLine: string;
  private top = { line: 0, segment: 0 };
  private left = 0;
  /** The column within a row that ↑ and ↓ keep to while they are pressed in a row. */
  private goal: number | undefined;
  private problems: Problem[] = [];
  /** The version of the text the problems were found in. */
  private checkedVersion = -1;
  private checkCost = 0;
  private checkTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly now: () => number;
  private styled: StyledLine[] | undefined;
  private refreshedVersion = -1;
  private savedVersion: number;
  private isNew: boolean;
  private message: { text: string; error?: boolean } | undefined;
  private prompt: Prompt | undefined;
  private clipboard = '';
  /** Whether the last key cut a line: cuts in a row collect into one paste. */
  private cutting = false;
  private lastFind = '';

  constructor(private readonly opts: EditorOptions) {
    this.firstLine = opts.text.split('\n', 1)[0];
    this.lang = opts.language(this.firstLine);
    this.now = opts.now ?? (() => performance.now());
    this.buffer = new TextBuffer(opts.text, { indentWithTabs: this.lang === 'makefile', now: this.now });
    this.rows = opts.rows;
    this.cols = opts.cols;
    this.screen = new Screen(opts.write);
    this.savedVersion = this.buffer.version;
    this.isNew = opts.isNew;
  }

  /** Prose wraps at the window's edge; code scrolls sideways. */
  private get wrap(): boolean {
    return this.lang === undefined || this.lang === 'markdown';
  }

  get modified(): boolean {
    return this.buffer.version !== this.savedVersion;
  }

  private get textRows(): number {
    return Math.max(1, this.rows - 2);
  }

  private get textWidth(): number {
    return Math.max(1, this.cols - gutterWidth(this.buffer.lines.length));
  }

  async start(): Promise<void> {
    await this.redraw();
  }

  /** Handles a chunk of input; true when the editor is done. */
  async feed(bytes: Uint8Array): Promise<boolean> {
    for (const key of this.keys.feed(bytes)) {
      if (await this.handle(key)) return true;
    }
    await this.redraw();
    return false;
  }

  /** Stops a check that waits for a pause. */
  close() {
    clearTimeout(this.checkTimer);
    this.checkTimer = undefined;
  }

  async resize(rows: number, cols: number): Promise<void> {
    this.rows = rows;
    this.cols = cols;
    this.screen.invalidate();
    await this.redraw();
  }

  // --- Keys -------------------------------------------------------------------------------

  private async handle(key: Key): Promise<boolean> {
    this.message = undefined;
    if (this.prompt) return await this.handlePrompt(key, this.prompt);
    const wasCutting = this.cutting;
    this.cutting = false;
    if (!(key.type === 'key' && (key.name === 'up' || key.name === 'down' || key.name === 'pageup' || key.name === 'pagedown'))) this.goal = undefined;

    if (key.type === 'text') {
      this.buffer.type(key.text);
      return false;
    }
    if (key.type === 'paste') {
      this.buffer.paste(key.text);
      return false;
    }
    const buffer = this.buffer;
    if (key.ctrl && !key.alt && key.name.length === 1) {
      switch (key.name) {
        case 's':
        case 'o':
          return await this.save(false);
        case 'q':
        case 'x':
          if (!this.modified) return true;
          this.prompt = { kind: 'quit', label: 'Save changes? (y/n, Esc cancels) ' };
          return false;
        case 'f':
          this.prompt = { kind: 'find', label: 'Find: ', input: this.lastFind };
          return false;
        case 'g':
          this.prompt = { kind: 'goto', label: 'Go to line[:column]: ', input: '' };
          return false;
        case 'z':
          if (!buffer.undo()) this.message = { text: 'Nothing to undo' };
          return false;
        case 'y':
          if (!buffer.redo()) this.message = { text: 'Nothing to redo' };
          return false;
        case 'k': {
          const cut = buffer.cutLine();
          this.clipboard = wasCutting ? this.clipboard + cut : cut;
          this.cutting = true;
          return false;
        }
        case 'u':
          buffer.paste(this.clipboard);
          return false;
        case 'a':
          this.home();
          return false;
        case 'e':
          this.end();
          return false;
        case 'c':
          this.message = { text: '^Q quits' };
          return false;
      }
      return false;
    }
    switch (key.name) {
      case 'enter':
        buffer.newline();
        break;
      case 'tab':
        if (!key.shift) buffer.indent();
        break;
      case 'backspace':
        buffer.backspace();
        break;
      case 'delete':
        buffer.deleteForward();
        break;
      case 'left':
        if (key.ctrl || key.alt) buffer.wordLeft();
        else buffer.left();
        break;
      case 'right':
        if (key.ctrl || key.alt) buffer.wordRight();
        else buffer.right();
        break;
      case 'up':
        this.vertical(-1);
        break;
      case 'down':
        this.vertical(1);
        break;
      case 'pageup':
        this.vertical(-this.textRows);
        break;
      case 'pagedown':
        this.vertical(this.textRows);
        break;
      case 'home':
        if (key.ctrl) buffer.moveTo({ line: 0, col: 0 });
        else this.home();
        break;
      case 'end':
        if (key.ctrl) buffer.moveTo({ line: buffer.lines.length - 1, col: Infinity });
        else this.end();
        break;
    }
    return false;
  }

  private async handlePrompt(key: Key, prompt: Prompt): Promise<boolean> {
    if (key.type === 'key' && (key.name === 'escape' || (key.ctrl && key.name === 'c'))) {
      this.prompt = undefined;
      return false;
    }
    if (prompt.kind === 'find' || prompt.kind === 'goto') {
      if (key.type !== 'key') prompt.input += key.text.split('\n')[0];
      else if (key.name === 'backspace') prompt.input = [...prompt.input].slice(0, -1).join('');
      else if (key.name === 'enter') {
        this.prompt = undefined;
        if (prompt.kind === 'find') this.find(prompt.input);
        else this.goto(prompt.input);
      }
      return false;
    }
    const answer = key.type === 'text' ? key.text[0].toLowerCase() : key.type === 'key' && key.name === 'enter' ? '' : undefined;
    if (answer === undefined) return false;
    if (prompt.kind === 'quit') {
      if (answer === 'n') return true;
      if (answer !== 'y') return false;
      this.prompt = undefined;
      return await this.save(true);
    }
    // Saving over a syntax error is a yes asked for, not a default.
    this.prompt = undefined;
    if (answer === 'y') return await this.write(prompt.kind === 'save-anyway' && prompt.thenQuit);
    this.message = { text: 'Not saved' };
    return false;
  }

  // --- Commands ---------------------------------------------------------------------------

  /** Saves, asking first when the text has syntax errors; true when it saved and should quit. */
  private async save(thenQuit: boolean): Promise<boolean> {
    await this.refresh();
    if (this.checkedVersion !== this.buffer.version) await this.checkNow();
    const problem = this.currentProblems[0];
    if (problem) {
      // The question goes first, so a narrow terminal shows it; the error itself is in the status bar.
      this.prompt = { kind: 'save-anyway', label: `Save with errors? (y/N)  ${describe(problem)} `, thenQuit };
      return false;
    }
    return await this.write(thenQuit);
  }

  private async write(thenQuit: boolean): Promise<boolean> {
    try {
      await this.opts.save(this.buffer.text);
    } catch (error) {
      this.message = { text: `Not saved: ${error instanceof Error ? error.message : String(error)}`, error: true };
      return false;
    }
    this.savedVersion = this.buffer.version;
    this.isNew = false;
    this.message = { text: 'Saved' };
    return thenQuit;
  }

  private find(needle: string) {
    this.lastFind = needle;
    const found = this.buffer.find(needle);
    if (!found) {
      this.message = { text: 'Not found' };
      return;
    }
    this.buffer.moveTo(found.pos);
    if (found.wrapped) this.message = { text: 'Search wrapped' };
  }

  private goto(input: string) {
    const match = /^\s*(\d+)\s*(?::\s*(\d+))?\s*$/.exec(input);
    if (!match) {
      if (input.trim()) this.message = { text: 'Not a line number' };
      return;
    }
    this.buffer.moveTo({ line: Number(match[1]) - 1, col: Number(match[2] ?? 1) - 1 });
  }

  // --- Layout and movement ----------------------------------------------------------------

  private segments(cells: Cell[]): Segment[] {
    return this.wrap ? wrapSegments(cells, this.textWidth) : [{ from: 0, to: cells.length }];
  }

  /** Where the cursor is drawn: its line's cells and segments, its cell and its segment. */
  private cursorPlace() {
    const { line, col } = this.buffer.cursor;
    const text = this.buffer.lines[line];
    const cells = layoutLine(text);
    const segments = this.segments(cells);
    let cell = cells.findIndex((c) => c.start >= col);
    if (cell < 0) cell = cells.length;
    return { line, text, cells, segments, cell, segment: segmentOf(segments, cell) };
  }

  /** Up or down by screen rows, keeping to the column the first move started from. */
  private vertical(delta: number) {
    const lines = this.buffer.lines;
    let { line, text, cells, segments, segment } = this.cursorPlace();
    const rowStart = (s: number) => displayColumn(cells, cellStart(cells, segments[s].from, text));
    this.goal ??= displayColumn(cells, this.buffer.cursor.col) - rowStart(segment);
    for (let step = 0; step < Math.abs(delta); step++) {
      if (delta < 0 && segment > 0) segment--;
      else if (delta > 0 && segment < segments.length - 1) segment++;
      else if (delta < 0 ? line > 0 : line < lines.length - 1) {
        line += Math.sign(delta);
        text = lines[line];
        cells = layoutLine(text);
        segments = this.segments(cells);
        segment = delta < 0 ? segments.length - 1 : 0;
      } else {
        // Past the first or last line: to its start or end.
        this.buffer.moveTo({ line, col: delta < 0 ? 0 : text.length });
        return;
      }
    }
    const { from, to } = segments[segment];
    let index = cellAt(cells, this.goal, from, to);
    // The end of a wrapped row is the start of the next one: stay on the last character.
    if (index === to && segment < segments.length - 1) index = Math.max(from, to - 1);
    this.buffer.moveTo({ line, col: cellStart(cells, index, text) });
  }

  /** To the start of the screen row in wrapped text, else the first non-blank or the line's start. */
  private home() {
    const { line, text, cells, segments, segment } = this.cursorPlace();
    if (segment > 0) this.buffer.moveTo({ line, col: cellStart(cells, segments[segment].from, text) });
    else this.buffer.home();
  }

  /** To the end of the screen row in wrapped text, else the end of the line. */
  private end() {
    const { line, text, cells, segments, segment } = this.cursorPlace();
    if (segment < segments.length - 1) this.buffer.moveTo({ line, col: cellStart(cells, segments[segment].to - 1, text) });
    else this.buffer.end();
  }

  /** Scrolls so the cursor is on screen. */
  private scrollToCursor() {
    const lines = this.buffer.lines;
    const segmentCount = (line: number) => this.segments(layoutLine(lines[line])).length;
    const top = this.top;
    top.line = Math.min(top.line, lines.length - 1);
    top.segment = Math.min(top.segment, segmentCount(top.line) - 1);
    const { line, cells, segment } = this.cursorPlace();
    const before = (l: number, s: number) => l < top.line || (l === top.line && s < top.segment);
    if (before(line, segment)) {
      this.top = { line, segment };
    } else {
      // Walk up a screen from the cursor; a top further up than that comes down to where the walk ended.
      let l = line;
      let s = segment;
      for (let room = this.textRows - 1; room > 0 && !before(l, s) && (l !== top.line || s !== top.segment); room--) {
        if (s > 0) s--;
        else {
          l--;
          s = segmentCount(l) - 1;
        }
      }
      if (!before(l, s) && (l !== top.line || s !== top.segment)) this.top = { line: l, segment: s };
    }
    if (this.wrap) {
      this.left = 0;
      return;
    }
    const x = displayColumn(cells, this.buffer.cursor.col);
    // Back to the line's start when the cursor fits there, so the indent stays in view.
    if (x < this.left) this.left = x < this.textWidth ? 0 : x;
    else if (x >= this.left + this.textWidth) this.left = x - this.textWidth + 1;
  }

  // --- Drawing ----------------------------------------------------------------------------

  /** Highlights the text again if it changed, and checks it: at once while checks are quick, else after a pause. */
  private async refresh() {
    const version = this.buffer.version;
    if (version !== this.refreshedVersion) {
      this.refreshedVersion = version;
      if (this.buffer.lines[0] !== this.firstLine) {
        this.firstLine = this.buffer.lines[0];
        this.lang = this.opts.language(this.firstLine);
      }
      this.styled = highlightLines(this.buffer.text, this.lang);
    }
    if (version === this.checkedVersion) return;
    if (this.checkCost <= LIVE_CHECK_MS) await this.checkNow();
    else this.checkAfterPause();
  }

  /** Checks the text as it is now; what is found is dropped if the text changed meanwhile. */
  private async checkNow() {
    this.close();
    const version = this.buffer.version;
    const started = this.now();
    const problems = isCheckable(this.lang) ? await check(this.lang, this.buffer.text) : [];
    this.checkCost = this.now() - started;
    if (this.buffer.version !== version) return;
    this.problems = problems;
    this.checkedVersion = version;
  }

  private checkAfterPause() {
    this.close();
    this.checkTimer = setTimeout(() => {
      this.checkTimer = undefined;
      this.checkNow().then(() => this.redraw()).catch(() => {});
    }, CHECK_PAUSE_MS);
  }

  /** The problems of the text as it is; none while a check of it is still to come. */
  private get currentProblems(): Problem[] {
    return this.checkedVersion === this.buffer.version ? this.problems : [];
  }

  private statusLeft(): Run[] {
    const runs: Run[] = [{ text: ` ${this.opts.name}${this.isNew ? ' [New]' : ''}${this.modified ? ' [Modified]' : ''}  `, style: '' }];
    if (this.message) {
      runs.push({ text: ` ${this.message.text} `, style: this.message.error ? ERROR_STYLE : '' });
      return runs;
    }
    const problems = this.currentProblems;
    const cursorLine = this.buffer.cursor.line + 1;
    const problem = problems.find((p) => p.line === cursorLine) ?? problems[0];
    if (problem) {
      const more = problems.length > 1 ? ` (+${problems.length - 1} more)` : '';
      runs.push({ text: ` ${describe(problem)}${more} `, style: ERROR_STYLE });
    }
    return runs;
  }

  private statusRight(): Run[] {
    const lang = this.lang;
    const name = lang ? LANGUAGE_NAMES[lang] ?? lang : 'text';
    const pending = this.checkedVersion !== this.buffer.version;
    const verdict = !isCheckable(lang) ? '' : pending ? ' …' : this.currentProblems.length ? ' ✗' : ' ✓';
    const { line, col } = this.buffer.cursor;
    return [{ text: `${name}${verdict}   L ${line + 1}:${col + 1} `, style: '' }];
  }

  private bottom(): { runs: Run[]; cursor?: number } {
    const prompt = this.prompt;
    if (prompt) {
      const input = 'input' in prompt ? prompt.input : '';
      return { runs: [{ text: prompt.label, style: '1' }, { text: input, style: '' }], cursor: textWidth(prompt.label + input) };
    }
    return { runs: HELP.flatMap(([key, label]) => [{ text: key, style: '7' }, { text: ` ${label}  `, style: '' }]) };
  }

  private async redraw() {
    await this.refresh();
    this.scrollToCursor();
    const bottom = this.bottom();
    await this.screen.draw(render({
      rows: this.rows,
      cols: this.cols,
      lines: this.buffer.lines,
      styled: this.styled,
      problems: this.currentProblems,
      cursor: this.buffer.cursor,
      top: this.top,
      left: this.left,
      wrap: this.wrap,
      statusLeft: this.statusLeft(),
      statusRight: this.statusRight(),
      bottom: bottom.runs,
      promptCursor: bottom.cursor,
    }));
  }
}
