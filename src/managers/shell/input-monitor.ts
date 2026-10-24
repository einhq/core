/**
 * Reads raw stdin and writes what commands are to read to filtered stdin: everything in raw
 * mode; in cooked mode, all but Ctrl-C and Ctrl-D, which become `onSignal` calls. Every chunk
 * that arrives is also an `onInput` call.
 */

import { ResourceHandleIf } from '../../registries/types.ts';
import { Action, identifyActions } from './readline/action.ts';

export type TerminalMode = 'raw' | 'cooked';

type InputMonitorConfig = {
  rawStdin: ResourceHandleIf;
  filteredStdin: ResourceHandleIf;
  onInput?: () => void;
  onSignal: (signal: 'interrupt' | 'eof') => void;
};

/** The bytes an action was read from, to forward. */
function reconstructBytes(action: Action): string {
  switch (action.type) {
    case 'insert':
      return action.data!;
    case 'interrupt':
      return '\x03';
    case 'exit':
      return '\x04';
    case 'lf':
      return '\x0a';
    case 'cr':
      return '\x0d';
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
  }

  private async readLoop(): Promise<void> {
    while (this.running && this.reader) {
      try {
        const { done, value } = await this.reader.read();

        if (done) {
          this.config.onSignal('eof');
          break;
        }

        if (!value || value.length === 0) {
          continue;
        }

        this.config.onInput?.();

        if (this.mode === 'raw') {
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
        this.config.onSignal('interrupt');
      } else if (action.type === 'exit') {
        this.config.onSignal('eof');
      } else {
        filtered += reconstructBytes(action);
      }
    }

    if (filtered.length > 0) {
      await this.config.filteredStdin.write(this.encoder.encode(filtered));
    }
  }
}
