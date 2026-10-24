import { parseArgs } from '../../../../lib/args/mod.ts';
import type { Command } from '../../command.ts';
import { operands } from '../../input.ts';
import { signalExitCode } from '../../signal.ts';
import { CmdReturn } from '../../types.ts';

/** A field or character list such as "1", "1-3", "1,3,5" or "1-3,5-7", as a test of a 0-based index. */
function parseRanges(spec: string): (index: number) => boolean {
  const ranges: { start: number; end: number }[] = [];

  for (const part of spec.split(',')) {
    const trimmed = part.trim();
    if (trimmed.includes('-')) {
      const [startStr, endStr] = trimmed.split('-');
      const start = startStr ? parseInt(startStr, 10) : 1;
      const end = endStr ? parseInt(endStr, 10) : Infinity;
      ranges.push({ start: start - 1, end: end - 1 }); // Convert to 0-based
    } else {
      const n = parseInt(trimmed, 10) - 1; // Convert to 0-based
      ranges.push({ start: n, end: n });
    }
  }

  return (index: number): boolean => {
    return ranges.some((r) => index >= r.start && index <= r.end);
  };
}

export const cut = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    alias: {
      d: 'delimiter',
      f: 'fields',
      c: 'characters',
      s: 'only-delimited',
    },
    boolean: ['s'],
    string: ['d', 'f', 'c'],
  });

  if (!flags.fields && !flags.characters) {
    await cmd.writeError('cut: you must specify a list of bytes, characters, or fields\n');
    return 1;
  }

  // An empty delimiter would make split() cut the line into single characters,
  // a -c run nobody asked for.
  if (flags.delimiter !== undefined && [...flags.delimiter].length !== 1) {
    await cmd.writeError('cut: the delimiter must be a single character\n');
    return 1;
  }

  const delimiter = flags.delimiter ?? '\t';
  const characters = flags.characters ? parseRanges(flags.characters) : undefined;
  const fields = flags.fields ? parseRanges(flags.fields) : undefined;

  /** The line cut down, or undefined for a line -s skips. */
  const cutLine = (line: string): string | undefined => {
    if (characters) return [...line].filter((_, i) => characters(i)).join(''); // By code point, not UTF-16 unit.
    // A line without the delimiter is printed whole, or with -s skipped.
    if (!line.includes(delimiter)) return flags['only-delimited'] ? undefined : line;
    return line.split(delimiter).filter((_, i) => fields!(i)).join(delimiter);
  };

  const inputs = operands(cmd, flags._);
  for await (const input of inputs) {
    for await (const line of input.lines()) {
      const cut = cutLine(line);
      if (cut !== undefined) await cmd.write(`${cut}\n`);
    }
  }
  if (cmd.interrupted) return signalExitCode(cmd.signal ?? 'SIGINT');
  return inputs.failed ? 1 : 0;
};

cut.spec = {
  name: 'cut',
  effect: 'read' as const,
  json: false,
  description: 'Remove sections from each line of files',
  args: [
    {
      name: 'FILE',
      type: 'path' as const,
      description: 'files to cut, one after the other (stdin if omitted, or for -)',
      variadic: true,
    },
  ],
  flags: [
    { name: 'd', type: 'string' as const, description: 'use DELIM instead of TAB for field delimiter' },
    { name: 'f', type: 'string' as const, description: 'select only these fields (e.g., -f1, -f1-3, -f1,3)' },
    { name: 'c', type: 'string' as const, description: 'select only these characters (e.g., -c1-5)' },
    { name: 's', type: 'bool' as const, description: 'do not print lines not containing delimiters' },
  ],
};
