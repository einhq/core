import { parseArgs } from '../../../../lib/args/mod.ts';
import type { Command } from '../../command.ts';
import { operands } from '../../input.ts';
import { signalExitCode } from '../../signal.ts';
import { CmdReturn } from '../../types.ts';

export const uniq = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    alias: {
      c: 'count',
      d: 'repeated',
      u: 'unique',
      i: 'ignore-case',
    },
    boolean: ['c', 'd', 'u', 'i'],
  });

  const [file = '-', output] = flags._.map(String);
  if (output !== undefined) {
    await cmd.writeError(`uniq: ${output}: an OUTPUT operand is not supported; redirect stdout instead\n`);
    return 1;
  }

  // A run of equal lines is written once the line after it differs, or the input ends.
  let run: { line: string; compare: string; count: number } | undefined;
  const writeRun = async () => {
    if (!run || (flags.repeated && run.count === 1) || (flags.unique && run.count > 1)) return;
    await cmd.write(flags.count ? `${run.count.toString().padStart(7)} ${run.line}\n` : `${run.line}\n`);
  };

  const inputs = operands(cmd, [file]);
  for await (const input of inputs) {
    for await (const line of input.lines()) {
      const compare = flags['ignore-case'] ? line.toLowerCase() : line;
      if (run?.compare === compare) {
        run.count++;
        continue;
      }
      await writeRun();
      run = { line, compare, count: 1 };
    }
  }
  if (cmd.interrupted) return signalExitCode(cmd.signal ?? 'SIGINT');
  if (inputs.failed) return 1;
  await writeRun();
  return 0;
};

uniq.spec = {
  name: 'uniq',
  effect: 'read' as const,
  json: false,
  description: 'Report or omit repeated lines',
  args: [
    {
      name: 'INPUT',
      type: 'path' as const,
      description: 'file to read (stdin if omitted, or for -)',
      optional: true,
    },
  ],
  flags: [
    { name: 'c', type: 'bool' as const, description: 'prefix lines by the number of occurrences' },
    { name: 'd', type: 'bool' as const, description: 'only print duplicate lines' },
    { name: 'u', type: 'bool' as const, description: 'only print unique lines' },
    { name: 'i', type: 'bool' as const, description: 'ignore differences in case when comparing' },
  ],
};
