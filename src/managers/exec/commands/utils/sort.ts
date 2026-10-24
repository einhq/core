import { parseArgs } from '../../../../lib/args/mod.ts';
import type { Command } from '../../command.ts';
import { operands } from '../../input.ts';
import { signalExitCode } from '../../signal.ts';
import { CmdReturn } from '../../types.ts';

export const sort = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    alias: {
      r: 'reverse',
      n: 'numeric-sort',
      u: 'unique',
      k: 'key',
      t: 'field-separator',
    },
    boolean: ['r', 'n', 'u'],
    string: ['k', 't'],
  });

  // As in GNU sort, a FILE that cannot be read fails the sort before anything is printed.
  const inputs = operands(cmd, flags._, { stopAtError: true });
  const lines: string[] = [];
  for await (const input of inputs) {
    for await (const line of input.lines()) lines.push(line);
  }
  if (cmd.interrupted) return signalExitCode(cmd.signal ?? 'SIGINT');
  if (inputs.failed) return 2;

  // -k2 or -k2,2
  let keyField: number | null = null;
  if (flags.key) {
    const keyMatch = flags.key.match(/^(\d+)/);
    if (keyMatch) {
      keyField = parseInt(keyMatch[1], 10) - 1; // Convert to 0-based index
    }
  }

  const separator = flags['field-separator'] || /\s+/;

  const compare = (a: string, b: string): number => {
    let valA = a;
    let valB = b;

    if (keyField !== null) {
      const partsA = a.split(separator);
      const partsB = b.split(separator);
      valA = partsA[keyField] ?? '';
      valB = partsB[keyField] ?? '';
    }

    let result: number;
    if (flags['numeric-sort']) {
      const numA = parseFloat(valA) || 0;
      const numB = parseFloat(valB) || 0;
      result = numA - numB;
    } else {
      result = valA.localeCompare(valB);
    }

    return flags.reverse ? -result : result;
  };

  lines.sort(compare);
  const sorted = flags.unique ? lines.filter((line, index, arr) => index === 0 || line !== arr[index - 1]) : lines;

  for (const line of sorted) {
    await cmd.write(`${line}\n`);
  }

  return 0;
};

sort.spec = {
  name: 'sort',
  effect: 'read' as const,
  json: false,
  description: 'Sort lines of text',
  args: [
    {
      name: 'FILE',
      type: 'path' as const,
      description: 'files whose lines are sorted together (stdin if omitted, or for -)',
      variadic: true,
    },
  ],
  flags: [
    { name: 'r', type: 'bool' as const, description: 'reverse the result of comparisons' },
    { name: 'n', type: 'bool' as const, description: 'compare according to string numerical value' },
    { name: 'u', type: 'bool' as const, description: 'output only unique lines' },
    { name: 'k', type: 'string' as const, description: 'sort by a key field (e.g., -k2)' },
    { name: 't', type: 'string' as const, description: 'use SEP as field separator' },
  ],
};
