import { parseArgs } from '../../../../lib/args/mod.ts';
import type { Command } from '../../command.ts';
import { operands } from '../../input.ts';
import { signalExitCode } from '../../signal.ts';
import { CmdReturn } from '../../types.ts';

export const grep = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    alias: {
      i: 'ignore-case',
      v: 'invert-match',
      c: 'count',
      n: 'line-number',
      o: 'only-matching',
      E: 'extended-regexp',
      F: 'fixed-strings',
      q: 'quiet',
    },
    boolean: ['i', 'v', 'c', 'n', 'o', 'E', 'F', 'q'],
  });

  const pattern = flags._[0] as string | undefined;
  if (!pattern) {
    await cmd.writeError('grep: missing pattern\n');
    return 2;
  }

  let regex: RegExp;
  try {
    if (flags['fixed-strings']) {
      // -F: the pattern is literal.
      const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      regex = new RegExp(escaped, flags['ignore-case'] ? 'gi' : 'g');
    } else {
      regex = new RegExp(pattern, flags['ignore-case'] ? 'gi' : 'g');
    }
  } catch {
    await cmd.writeError(`grep: invalid pattern: ${pattern}\n`);
    return 2;
  }

  const files = flags._.slice(1);
  const inputs = operands(cmd, files);
  let matchCount = 0;
  for await (const input of inputs) {
    let lineNum = 0;
    for await (const line of input.lines()) {
      lineNum++;
      const matches = line.match(regex);
      const hasMatch = matches !== null && matches.length > 0;
      if (flags['invert-match'] ? hasMatch : !hasMatch) continue;

      matchCount++;
      // -q: the first match settles it.
      if (flags.quiet) return 0;
      if (flags.count) continue;

      // [file:][lineNum:]
      const prefix = (files.length > 1 ? `${input.name}:` : '') + (flags['line-number'] ? `${lineNum}:` : '');
      if (flags['only-matching'] && !flags['invert-match'] && matches) {
        // -o: only the matching parts.
        await cmd.write(matches.map((match) => `${prefix}${match}\n`).join(''));
      } else {
        await cmd.write(`${prefix}${line}\n`);
      }
    }
  }
  if (cmd.interrupted) return signalExitCode(cmd.signal ?? 'SIGINT');

  if (flags.count) await cmd.write(`${matchCount}\n`);
  // A FILE that could not be read makes the status 2, as in GNU grep, unless -q found a match.
  if (inputs.failed) return 2;
  return matchCount > 0 ? 0 : 1;
};

grep.spec = {
  name: 'grep',
  effect: 'read' as const,
  json: false,
  description: 'Search for patterns in input',
  args: [
    {
      name: 'PATTERN',
      type: 'string' as const,
      description: 'the pattern to search for',
    },
    {
      name: 'FILE',
      type: 'path' as const,
      description: 'files to search (stdin if omitted, or for -)',
      variadic: true,
    },
  ],
  flags: [
    { name: 'i', type: 'bool' as const, description: 'ignore case distinctions' },
    { name: 'v', type: 'bool' as const, description: 'select non-matching lines' },
    { name: 'c', type: 'bool' as const, description: 'print only a count of matching lines' },
    { name: 'n', type: 'bool' as const, description: 'prefix each line with line number' },
    { name: 'o', type: 'bool' as const, description: 'show only the matching part of lines' },
    { name: 'E', type: 'bool' as const, description: 'interpret pattern as extended regexp' },
    { name: 'F', type: 'bool' as const, description: 'interpret pattern as fixed string' },
    { name: 'q', type: 'bool' as const, description: 'quiet mode, exit with 0 on match, 1 otherwise' },
  ],
  examples: [
    'grep -n exempelord /archive/albums/Exempelalbum_2019/files/notes.txt',
  ],
  returns: 'the matching lines.',
};
