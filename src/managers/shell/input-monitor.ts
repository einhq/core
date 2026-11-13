/**
 * Reads raw stdin and writes what commands are to read to filtered stdin. Without a terminal that
 * is every byte as it came, as a pipe passes them. With one: everything in raw mode; in cooked
 * mode, all but Ctrl-C and Ctrl-D, with CR turned into LF as a terminal's ICRNL does, so Enter
 * ends a line. Ctrl-C becomes an `onInterrupt` call. Ctrl-D marks end of file on
 * filtered stdin, so the command reading the terminal sees its input end, as a terminal's VEOF
 * does; typed bytes go on at once, so nothing is pending when it comes. Marks no read reached are
 * dropped when the prompt takes the terminal back (raw mode), where an empty read would end the
 * shell. Every chunk that arrives is also an `onInput` call. When raw stdin ends, so does filtered
 * stdin.
 */

import { ResourceHandleIf } from '../../registries/types.ts';
import type { BufferHandle } from '../buffer/buffer-handle.ts';
import { Action, identifyActions } from './readline/action.ts';

export type TerminalMode = 'raw' | 'cooked';

type InputMonitorConfig = {
  rawStdin: ResourceHandleIf;
  filteredStdin: Pick<BufferHandle, 'write' | 'writeEOF' | 'markEOF' | 'dropEOFMarks'>;
  /** Whether raw stdin is a terminal's input: only then are keys such as Ctrl-C read from it. */
  terminal: boolean;
  onInput?: () => void;
  onInterrupt: () => void;
};

/** The bytes an action was read from, to forward in cooked mode. */
function reconstructBytes(action: Action): string {
  switch (action.type) {
    case 'insert':
      return action.data!;
    case 'lf':
      return '\x0a';
    case 'cr':
      return '\x0a';
    case 'backspace':
      return '\x7f';
    case 'delete':
      return '\x7e';
    case 'tab':
      return '\t';
    case 'escape':
      return '\x1b';
    case 'moveUp':
      return '\x1b[A';
    case 'moveDown':
      return '\x1b[B';
    case 'moveRight':
      return '\x1b[C';
    case 'moveLeft':
      return '\x1b[D';
    case 'moveHome':
      return '\x1b[H';
    case 'moveEnd':
      return '\x1b[F';
    case 'nop':
      return '';
    default:
      return '';
  }
}

export class InputMonitor {
  private mode: TerminalMode = 'cooked';
  private running = false;
  private reader?: ReadableStreamDefaultReader<Uint8Array>;
  private decoder = new TextDecoder();
  private encoder = new TextEncoder();

  constructor(private config: InputMonitorConfig) {}

  async start(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    const stream = this.config.rawStdin.readable;
    this.reader = stream.getReader();

    this.readLoop().catch((err) => {
      if (this.running) {
        console.error('InputMonitor read loop error:', err);
      }
    });
  }

  stop(): void {
    this.running = false;
    if (this.reader) {
      this.reader.cancel().catch(() => {
        // Ignore cancel errors
      });
      this.reader = undefined;
    }
  }

  setMode(mode: TerminalMode): void {
    this.mode = mode;

    if (mode === 'raw') {
      this.config.filteredStdin.dropEOFMarks();
    }
  }

  private async readLoop(): Promise<void> {
    while (this.running && this.reader) {
      try {
        const { done, value } = await this.reader.read();

        if (done) {
          // Nothing more comes: what reads filtered stdin reads to its end, then EOF.
          await this.config.filteredStdin.writeEOF();
          break;
        }

        if (!value || value.length === 0) {
          continue;
        }

        this.config.onInput?.();

        if (!this.config.terminal || this.mode === 'raw') {
          await this.config.filteredStdin.write(value);
        } else {
          await this.processCookedInput(value);
        }
      } catch (err) {
        if (this.running) {
          console.error('InputMonitor read error:', err);
        }
        break;
      }
    }
  }

  private async processCookedInput(value: Uint8Array): Promise<void> {
    const text = this.decoder.decode(value, { stream: true });
    const actions = identifyActions(text);

    let filtered = '';

    for (const action of actions) {
      if (action.type === 'interrupt') {
        this.config.onInterrupt();
      } else if (action.type === 'exit') {
        await this.flush(filtered);
        filtered = '';
        // The prompt may have taken the terminal back while the write waited.
        if (this.mode === 'cooked') {
          this.config.filteredStdin.markEOF();
        }
      } else {
        filtered += reconstructBytes(action);
      }
    }

    await this.flush(filtered);
  }

  private async flush(filtered: string): Promise<void> {
    if (filtered.length > 0) {
      await this.config.filteredStdin.write(this.encoder.encode(filtered));
    }
  }
}
