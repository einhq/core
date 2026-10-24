import { resolve } from '@std/path';
import { expandCountFlag, parseArgs } from '../../../../lib/args/mod.ts';
import { NODE_TYPE_QUEUE } from '../../../../vfs/types/queue.ts';
import type { Command } from '../../command.ts';
import type { Input } from '../../command-input.ts';
import { operands } from '../../input.ts';
import { signalExitCode } from '../../signal.ts';
import { CmdReturn } from '../../types.ts';

export const head = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(expandCountFlag(cmd.args), {
    alias: {
      n: 'lines',
      c: 'bytes',
    },
    string: ['n', 'c'],
  });

  const bytes = flags.bytes !== undefined;
  const spec = flags.bytes ?? flags.lines ?? '10';
  const count = Number(spec);
  if (!Number.isInteger(count) || count < 0) {
    await cmd.writeError(`head: invalid number of ${bytes ? 'bytes' : 'lines'}: '${spec}'\n`);
    return 1;
  }

  const operand = flags._.length > 0 ? String(flags._[0]) : '-';
  if (operand !== '-') {
    try {
      // Reading a queue claims what it reads, so the head of a queue is a peek,
      // which shows the same entries and takes none.
      const path = resolve(cmd.cwd, operand);
      if ((await cmd.sys.vfs.get(cmd.access, path)).type === NODE_TYPE_QUEUE) {
        const entries = await cmd.sys.vfs.queuePeek(cmd.access, path, count || 10);
        await cmd.write(entries.map((entry) => `${JSON.stringify(entry.data)}\n`).join(''));
        return 0;
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await cmd.writeError(`head: ${operand}: ${message}\n`);
      return 1;
    }
  }

  const inputs = operands(cmd, [operand]);
  for await (const input of inputs) {
    if (bytes) await firstBytes(cmd, input, count);
    else await firstLines(cmd, input, count);
  }
  if (cmd.interrupted) return signalExitCode(cmd.signal ?? 'SIGINT');
  return inputs.failed ? 1 : 0;
};

/** The first `count` lines, each as it comes; a last line without a newline stays without one. */
const firstLines = async (cmd: Command, input: Input, count: number) => {
  if (count === 0) return;
  let written = 0;
  for await (const line of input.lines({ keepNewline: true })) {
    await cmd.write(line);
    if (++written === count) return;
  }
};

/** The first `count` bytes, as they come. */
const firstBytes = async (cmd: Command, input: Input, count: number) => {
  if (count === 0) return;
  const decoder = new TextDecoder();
  let left = count;
  for await (const chunk of input.chunks()) {
    const part = chunk.subarray(0, left);
    left -= part.length;
    await cmd.write(decoder.decode(part, { stream: left > 0 }));
    if (left === 0) return;
  }
  await cmd.write(decoder.decode());
};

head.spec = {
  name: 'head',
  effect: 'read' as const,
  json: false,
  description: 'Output the first part of files, logs, or stdin; on a queue, the next entries without consuming them',
  args: [
    {
      name: 'path',
      type: 'path' as const,
      description: 'file, log or queue node to read (stdin if omitted, or for -)',
    },
  ],
  flags: [
    { name: 'n', type: 'string' as const, description: 'print the first NUM lines instead of the first 10 (-NUM works too)' },
    { name: 'c', type: 'string' as const, description: 'print the first NUM bytes' },
  ],
  examples: [
    'head -n 20 /archive/albums/Exempelalbum_2019/files/notes.txt',
  ],
  returns: 'the first lines of the file.',
};
