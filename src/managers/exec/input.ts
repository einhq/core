/**
 * A command's input: its stdin, or a node in the VFS that a FILE operand names (`-` for stdin),
 * read as bytes, lines or text until it ends or the command gets a terminating signal.
 */

import { resolve } from '@std/path';
import { LogHandle } from '../../registries/log/mod.ts';
import type { ResourceHandleIf } from '../../registries/types.ts';
import type { Command } from './command.ts';
import type { Input } from './command-input.ts';

const LOG_BATCH = 1000;

/** Where an input's bytes come from: `read` gives the next chunk, or undefined at the end. */
type Source = {
  read(): Promise<Uint8Array | undefined>;
  close?(): Promise<void>;
};

class SourceInput implements Input {
  constructor(readonly name: string, private cmd: Command, private source: Source) {}

  async *chunks(): AsyncGenerator<Uint8Array> {
    while (!this.cmd.interrupted) {
      const chunk = await this.source.read();
      if (!chunk) return;
      yield chunk;
    }
  }

  async *lines({ keepNewline = false }: { keepNewline?: boolean } = {}): AsyncGenerator<string> {
    const decoder = new TextDecoder();
    let rest = '';
    for await (const chunk of this.chunks()) {
      rest += decoder.decode(chunk, { stream: true });
      let start = 0;
      for (let end = rest.indexOf('\n'); end !== -1; end = rest.indexOf('\n', start)) {
        yield rest.slice(start, keepNewline ? end + 1 : end);
        start = end + 1;
      }
      rest = rest.slice(start);
    }
    rest += decoder.decode();
    // What came before a terminating signal may be half a line.
    if (rest !== '' && !this.cmd.interrupted) yield rest;
  }

  async text(): Promise<string> {
    const decoder = new TextDecoder();
    let text = '';
    for await (const chunk of this.chunks()) text += decoder.decode(chunk, { stream: true });
    return text + decoder.decode();
  }

  async close(): Promise<void> {
    await this.source.close?.();
  }
}

/**
 * A stream read through one reader. A terminating signal cancels the read in progress: a stdin
 * that nothing writes would otherwise hold the command in it for good.
 */
const streamSource = (cmd: Command, stream: ReadableStream<Uint8Array>) => {
  const reader = stream.getReader();
  const cancel = () => {
    reader.cancel().catch(() => {});
  };
  cmd.interruptSignal.addEventListener('abort', cancel, { once: true });
  return {
    read: async () => {
      const { done, value } = await reader.read();
      return done ? undefined : value;
    },
    release: () => {
      cmd.interruptSignal.removeEventListener('abort', cancel);
      reader.releaseLock();
    },
  };
};

/**
 * The command's stdin. It is read through one reader for as long as the handle stays open, so
 * what one read takes ahead of what it gives is there for the next.
 */
export const stdinInput = (cmd: Command): Input => {
  let handle: ResourceHandleIf | undefined;
  let stream: ReturnType<typeof streamSource> | undefined;
  return new SourceInput('-', cmd, {
    read: async () => {
      const current = await cmd.openStdin();
      if (current !== handle) {
        stream?.release();
        handle = current;
        stream = streamSource(cmd, current.readable);
      }
      return await stream!.read();
    },
  });
};

/** The node a FILE operand names, open for reading; a log is read to its current end, not followed. */
const openNode = async (cmd: Command, name: string): Promise<SourceInput> => {
  const handle = await cmd.sys.vfs.open(cmd.access, resolve(cmd.cwd, name), { mode: 'r' });
  if (handle instanceof LogHandle) {
    // A log's readable waits at the end for new entries; read() without a signal stops there.
    return new SourceInput(name, cmd, {
      read: async () => {
        const chunk = await handle.read(LOG_BATCH);
        return chunk.length > 0 ? chunk : undefined;
      },
      close: () => handle.close(),
    });
  }
  const stream = streamSource(cmd, handle.readable);
  return new SourceInput(name, cmd, {
    read: stream.read,
    close: async () => {
      stream.release();
      await handle.close();
    },
  });
};

/** The text of one operand: the node it names, or stdin for `-`. A node that cannot be opened throws. */
export const readOperand = async (cmd: Command, operand: string): Promise<string> => {
  if (operand === '-') return await cmd.stdin.text();
  const input = await openNode(cmd, operand);
  try {
    return await input.text();
  } finally {
    await input.close();
  }
};

/** What `operands` does with a FILE that cannot be opened. */
type OperandOptions = {
  /** End the inputs there, as sort and sed do, rather than go on with the next FILE. */
  stopAtError?: boolean;
  /** The line that reports it, instead of `<command>: <file>: <why>`. */
  error?: (file: string, why: string) => string;
};

/**
 * The inputs FILE operands name, in turn: stdin when there are none, and for `-`. A FILE that
 * cannot be opened is reported on stderr and sets `failed`. The inputs end when the command is
 * interrupted, so a command checks `cmd.interrupted` once its loop is done.
 */
class Operands implements AsyncIterable<Input> {
  /** Whether a FILE could not be opened. */
  failed = false;
  private files: string[];

  constructor(private cmd: Command, files: readonly (string | number)[], private opts: OperandOptions = {}) {
    this.files = files.length > 0 ? files.map(String) : ['-'];
  }

  async *[Symbol.asyncIterator](): AsyncGenerator<Input> {
    for (const file of this.files) {
      if (this.cmd.interrupted) return;
      if (file === '-') {
        yield this.cmd.stdin;
        continue;
      }
      let input: SourceInput;
      try {
        input = await openNode(this.cmd, file);
      } catch (error) {
        const why = error instanceof Error ? error.message : String(error);
        await this.cmd.writeError(`${this.opts.error?.(file, why) ?? `${this.cmd.name}: ${file}: ${why}`}\n`);
        this.failed = true;
        if (this.opts.stopAtError) return;
        continue;
      }
      try {
        yield input;
      } finally {
        await input.close();
      }
    }
  }
}

/** The inputs FILE operands name: see `Operands`. */
export const operands = (cmd: Command, files: readonly (string | number)[], opts: OperandOptions = {}): Operands => new Operands(cmd, files, opts);
