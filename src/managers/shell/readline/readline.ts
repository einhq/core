import { LineEditor, matchColumns } from '@ein/bash-executor';
import { ReadlineIO, ReadlineOptions } from './types.ts';

/** Escape sequences take no room on the screen. */
// deno-lint-ignore no-control-regex
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*\x07|[\x01\x02]/g;

/** How many columns text takes: its characters, its escape sequences none. */
const width = (text: string) => [...text.replace(ANSI, '')].length;

/**
 * A line read at a prompt. The editing is bash's readline's, done by the
 * executor's LineEditor — the emacs keys, C-r, C-o, the history it steps
 * through — and so is a Tab's, which the shell's executor completes as
 * readline does; this draws what they show on the terminal. One editor
 * lives for as long as the shell does,
 * so keys typed past the end of one line, and the line C-o brings back,
 * are there at the next prompt.
 */
export class Readline {
  private opts: ReadlineOptions;
  private io: ReadlineIO;
  private editor: LineEditor;
  private encoder = new TextEncoder();
  private decoder = new TextDecoder();
  /** The row the cursor was left on, counted from the prompt's, for the next drawing to go back up */
  private cursorRow = 0;

  constructor(opts: ReadlineOptions) {
    this.opts = opts;
    this.editor = opts.editor ?? new LineEditor();
    this.io = {
      in: this.createInGenerator(),
      out: this.getOutWriter(),
    };
  }

  private getOutWriter(): WritableStreamDefaultWriter<string> {
    const encoder = this.encoder;
    const stdoutWriter = this.opts.out.writable.getWriter();

    const stringStream = new WritableStream<string>({
      async write(chunk) {
        await stdoutWriter.write(encoder.encode(chunk));
      },
      close() {
        return stdoutWriter.close();
      },
      abort(err) {
        return stdoutWriter.abort(err);
      },
    });

    return stringStream.getWriter();
  }

  private async *createInGenerator(): AsyncGenerator<string | null, void, unknown> {
    const stream = this.opts.in.readable;
    const reader = stream.getReader();

    try {
      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          break;
        }

        yield this.decoder.decode(value, { stream: true });
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }

      reader.releaseLock();
      await stream.cancel();
    }
  }

  private async closeIO() {
    await this.io.out.close();
    await this.io.in.return();
  }

  public async write(data?: string) {
    if (data) {
      await this.io.out.write(data);
    }
  }

  /**
   * Read a line after `prompt`. Ctrl-D on an empty line is `EOT`, stdin going
   * away `EOF`, Ctrl-C `Interrupted`.
   */
  public async prompt(prompt = '') {
    try {
      this.editor.start();
      this.cursorRow = 0;
      await this.write('\x1b[2K\r');
      await this.draw(prompt);

      let results = this.editor.drain();

      while (true) {
        for (const result of results) {
          switch (result.kind) {
            case 'accept':
              await this.finish(prompt);
              return result.line;
            case 'eof':
              throw new Error('EOT');
            case 'interrupt':
              throw new Error('Interrupted');
            case 'complete':
              await this.tab(prompt, result.list);
              break;
            case 'clear':
              await this.write('\x1b[2J\x1b[H');
              this.cursorRow = 0;
              break;
          }
        }

        if (results.length > 0) await this.draw(prompt);

        // Keys left after a Tab or C-l, before reading more
        if (results.length > 0 && this.editor.pending) {
          results = this.editor.drain();
          continue;
        }

        // Manually iterate without for-await to avoid auto-closing the generator
        const next = await this.io.in.next();

        if (next.done) {
          throw new Error('EOF');
        }

        const text = next.value ?? '';

        // ESC on its own is the key, not the start of a sequence still to come
        results = text === '\x1b' ? [this.editor.flushEscape() ?? { kind: 'bell' }] : this.editor.feedText(text);
      }
    } finally {
      await this.closeIO();
    }
  }

  /** What is typed as the terminal is to show it: as it is, as stars, or not at all. */
  private shown(line: string): string {
    if (this.opts.echoMode === 'secret') return '*'.repeat([...line].length);
    if (this.opts.echoMode === 'none') return '';

    return line;
  }

  /**
   * The prompt and the line drawn again from the prompt's first row, and the
   * cursor put where the editor has it — on whichever row a long line wrapped it to.
   */
  private async draw(prompt: string): Promise<void> {
    const display = this.editor.display(prompt);
    const cols = Math.max(1, this.opts.cols || 80);
    const line = this.shown(display.line);
    const before = this.shown(display.line.slice(0, display.cursor));
    const start = width(display.prompt);
    const total = start + width(line);
    const cursor = start + width(before);
    let out = (this.cursorRow > 0 ? `\x1b[${this.cursorRow}A` : '') + '\r\x1b[J' + display.prompt + line;

    // A line that fills its last row leaves the cursor waiting to wrap: put it on the next
    if (total > 0 && total % cols === 0) out += ' \r';

    const endRow = Math.floor(total / cols);
    const row = Math.floor(cursor / cols);
    const col = cursor % cols;

    if (endRow > row) out += `\x1b[${endRow - row}A`;
    out += '\r' + (col > 0 ? `\x1b[${col}C` : '');

    this.cursorRow = row;
    await this.write(out);
  }

  /** The line done: drawn as it ends up, the cursor past its end, and a new line. */
  private async finish(prompt: string): Promise<void> {
    this.editor.setLine(this.editor.line);
    await this.draw(prompt);
    await this.write('\r\n');
    this.cursorRow = 0;
  }

  /** Tab: the line as the completion leaves it, and the matches listed under it when it lists them. */
  private async tab(prompt: string, list: boolean) {
    if (!this.opts.onTab) return;

    const result = await this.opts.onTab(this.editor.line, this.editor.point, list);

    this.editor.completed(result.line, result.point);

    if (result.list) {
      await this.finishRow(prompt);
      await this.write(matchColumns(result.list, this.opts.cols || 80, result.widest).replaceAll('\n', '\r\n'));
    }
  }

  /** Below what is drawn, for something to be written under it before the prompt comes again. */
  private async finishRow(prompt: string): Promise<void> {
    const point = this.editor.point;

    this.editor.setLine(this.editor.line);
    await this.draw(prompt);
    this.editor.setLine(this.editor.line, point);
    await this.write('\r\n');
    this.cursorRow = 0;
  }
}
