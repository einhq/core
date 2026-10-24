/**
 * fold: wrap each input line to a width, 80 columns unless -w says otherwise. `fold -w1` puts
 * every character on a line of its own, the usual first step of counting characters with
 * `sort | uniq -c`.
 *
 * -w WIDTH (also -wN, --width=N and the obsolescent -N), -s to break after the last blank that fits, -b to
 * count characters rather than columns (a tab otherwise moves to the next multiple of 8, and a
 * backspace moves back one). FILE arguments are read from the VFS, stdin when there are none or
 * for `-`. A last line without a newline keeps going without one.
 */

import type { Command } from '../../command.ts';
import { operands } from '../../input.ts';
import { signalExitCode } from '../../signal.ts';
import { CmdReturn } from '../../types.ts';

/** Where the column goes after `char`: characters count one, tabs and backspaces as a terminal moves. */
const advance = (column: number, char: string, bytes: boolean): number => {
  if (bytes) return column + 1;
  if (char === '\t') return column + 8 - (column % 8);
  if (char === '\b') return Math.max(column - 1, 0);
  if (char === '\r') return 0;
  return column + 1;
};

/** One line, without its newline, folded to `width`. */
export const foldLine = (line: string, width: number, spaces: boolean, bytes: boolean): string[] => {
  const out: string[] = [];
  let current: string[] = [];
  let column = 0;
  for (const char of line) {
    const next = advance(column, char, bytes);
    if (next > width && current.length > 0) {
      // -s: break after the last blank on the line, carrying what follows it to the next one.
      const blank = spaces ? current.findLastIndex((c) => c === ' ' || c === '\t') : -1;
      if (blank >= 0) {
        out.push(current.slice(0, blank + 1).join(''));
        current = current.slice(blank + 1);
      } else {
        out.push(current.join(''));
        current = [];
      }
      column = current.reduce((col, c) => advance(col, c, bytes), 0);
    }
    current.push(char);
    column = advance(column, char, bytes);
  }
  out.push(current.join(''));
  return out;
};

export const fold = async (cmd: Command): CmdReturn => {
  let width = 80;
  let spaces = false;
  let bytes = false;
  const files: string[] = [];

  const setWidth = async (text: string | undefined): Promise<boolean> => {
    const n = Number(text);
    if (!text || !Number.isInteger(n) || n < 1) {
      await cmd.writeError(`fold: invalid width: '${text ?? ''}'\n`);
      return false;
    }
    width = n;
    return true;
  };

  const args = [...cmd.args];
  let options = true;
  while (args.length > 0) {
    const a = args.shift()!;
    if (!options || !a.startsWith('-') || a === '-') {
      files.push(a);
      continue;
    }
    if (a === '--') {
      options = false;
      continue;
    }
    if (a.startsWith('--width')) {
      if (!await setWidth(a.includes('=') ? a.slice(a.indexOf('=') + 1) : args.shift())) return 1;
      continue;
    }
    if (a === '--spaces') {
      spaces = true;
      continue;
    }
    if (a === '--bytes') {
      bytes = true;
      continue;
    }
    // Short options, bundled: -sw10, -bs, and the obsolescent -80.
    if (/^-\d+$/.test(a)) {
      if (!await setWidth(a.slice(1))) return 1;
      continue;
    }
    for (let i = 1; i < a.length; i++) {
      const flag = a[i];
      if (flag === 's') spaces = true;
      else if (flag === 'b') bytes = true;
      else if (flag === 'w') {
        if (!await setWidth(i + 1 < a.length ? a.slice(i + 1) : args.shift())) return 1;
        break;
      } else {
        await cmd.writeError(`fold: invalid option -- '${flag}'\n`);
        return 1;
      }
    }
  }

  const inputs = operands(cmd, files);
  for await (const input of inputs) {
    for await (const line of input.lines({ keepNewline: true })) {
      const newline = line.endsWith('\n');
      await cmd.write(foldLine(newline ? line.slice(0, -1) : line, width, spaces, bytes).join('\n') + (newline ? '\n' : ''));
    }
  }
  if (cmd.interrupted) return signalExitCode(cmd.signal ?? 'SIGINT');
  return inputs.failed ? 1 : 0;
};

fold.spec = {
  name: 'fold',
  effect: 'read' as const,
  json: false,
  description: 'Wrap each input line to fit a width (fold -w1: one character per line)',
  args: [
    {
      name: 'FILE',
      type: 'path' as const,
      description: 'files to fold (reads from stdin if omitted)',
      variadic: true,
    },
  ],
  flags: [
    { name: 'w', type: 'number' as const, description: 'width in columns (default 80)' },
    { name: 's', type: 'bool' as const, description: 'break at the last blank that fits' },
    { name: 'b', type: 'bool' as const, description: 'count characters, not columns (tabs count one)' },
  ],
};
