import { parseArgs } from '../../../../lib/args/mod.ts';
import type { Command } from '../../command.ts';
import { CmdReturn } from '../../types.ts';

export const seq = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    alias: {
      s: 'separator',
      w: 'equal-width',
    },
    string: ['s'],
    boolean: ['w'],
    default: {
      s: '\n',
    },
  });

  const args = flags._.map((a) => parseFloat(String(a)));

  let first = 1;
  let increment = 1;
  let last: number;

  if (args.length === 1) {
    last = args[0];
  } else if (args.length === 2) {
    first = args[0];
    last = args[1];
  } else if (args.length >= 3) {
    first = args[0];
    increment = args[1];
    last = args[2];
  } else {
    await cmd.writeError('seq: missing operand\n');
    return 1;
  }

  if (isNaN(first) || isNaN(increment) || isNaN(last)) {
    await cmd.writeError('seq: invalid number\n');
    return 1;
  }

  if (increment === 0) {
    await cmd.writeError('seq: increment must not be zero\n');
    return 1;
  }

  let width = 0;
  if (flags['equal-width']) {
    const firstStr = String(first);
    const lastStr = String(last);
    width = Math.max(firstStr.length, lastStr.length);
  }

  const separator = flags.separator;
  const numbers: string[] = [];

  if (increment > 0) {
    for (let n = first; n <= last; n += increment) {
      let str = String(n);
      if (flags['equal-width']) {
        str = str.padStart(width, '0');
      }
      numbers.push(str);
    }
  } else {
    for (let n = first; n >= last; n += increment) {
      let str = String(n);
      if (flags['equal-width']) {
        str = str.padStart(width, '0');
      }
      numbers.push(str);
    }
  }

  if (numbers.length > 0) {
    await cmd.write(numbers.join(separator) + '\n');
  }

  return 0;
};

seq.spec = {
  name: 'seq',
  effect: 'read' as const,
  json: false,
  description: 'Print a sequence of numbers',
  args: [
    {
      name: 'LAST',
      type: 'string' as const,
      description: 'print numbers from 1 to LAST',
    },
    {
      name: 'FIRST LAST',
      type: 'string' as const,
      description: 'print numbers from FIRST to LAST',
    },
    {
      name: 'FIRST INCREMENT LAST',
      type: 'string' as const,
      description: 'print numbers from FIRST to LAST with INCREMENT',
    },
  ],
  flags: [
    { name: 's', type: 'string' as const, description: 'use STRING to separate numbers (default: newline)' },
    { name: 'w', type: 'bool' as const, description: 'equalize width by padding with leading zeroes' },
  ],
};
