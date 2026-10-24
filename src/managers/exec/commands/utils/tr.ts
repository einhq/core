import { parseArgs } from '../../../../lib/args/mod.ts';
import type { Command } from '../../command.ts';
import { signalExitCode } from '../../signal.ts';
import { CmdReturn } from '../../types.ts';

/** A set as its characters: ranges such as a-z expanded, escapes resolved. */
function expandCharClass(str: string): string {
  let result = '';
  let i = 0;

  while (i < str.length) {
    if (i + 2 < str.length && str[i + 1] === '-') {
      const start = str.charCodeAt(i);
      const end = str.charCodeAt(i + 2);

      if (start <= end) {
        for (let c = start; c <= end; c++) {
          result += String.fromCharCode(c);
        }
        i += 3;
        continue;
      }
    }

    if (str[i] === '\\' && i + 1 < str.length) {
      const next = str[i + 1];
      switch (next) {
        case 'n':
          result += '\n';
          break;
        case 't':
          result += '\t';
          break;
        case 'r':
          result += '\r';
          break;
        case '\\':
          result += '\\';
          break;
        default:
          result += next;
      }
      i += 2;
      continue;
    }

    result += str[i];
    i++;
  }

  return result;
}

export const tr = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    alias: {
      d: 'delete',
      s: 'squeeze-repeats',
      c: 'complement',
    },
    boolean: ['d', 's', 'c'],
  });

  const set1 = flags._[0] as string | undefined;
  const set2 = flags._[1] as string | undefined;

  if (!set1) {
    await cmd.writeError('tr: missing operand\n');
    return 1;
  }

  if (!flags.delete && !set2) {
    await cmd.writeError('tr: missing operand after SET1\n');
    return 1;
  }

  const chars1 = expandCharClass(set1);
  const chars2 = set2 ? expandCharClass(set2) : '';
  const set = new Set(chars1);
  // -c: SET1 is every character not in it.
  const inSet1 = (ch: string) => set.has(ch) !== Boolean(flags.complement);

  const translateMap = new Map<string, string>();
  for (let i = 0; i < chars1.length; i++) {
    // A shorter set2 repeats its last character.
    translateMap.set(chars1[i], chars2[Math.min(i, chars2.length - 1)] ?? '');
  }
  const translateChar = (ch: string) => flags.complement ? (inSet1(ch) ? chars2.at(-1)! : ch) : translateMap.get(ch) ?? ch;

  const squeezeSet = new Set(chars2);
  const squeezes = set2 ? (ch: string) => squeezeSet.has(ch) : inSet1;

  // The last character written, which a squeeze compares with across chunks.
  let last = '';
  const translate = (text: string): string => {
    let out = '';
    for (const ch of text) {
      if (flags.delete && inSet1(ch)) continue;
      const to = flags.delete ? ch : translateChar(ch);
      if (flags['squeeze-repeats'] && to === last && squeezes(to)) continue;
      out += to;
      last = to;
    }
    return out;
  };

  const decoder = new TextDecoder();
  for await (const chunk of cmd.stdin.chunks()) await cmd.write(translate(decoder.decode(chunk, { stream: true })));
  if (cmd.interrupted) return signalExitCode(cmd.signal ?? 'SIGINT');
  await cmd.write(translate(decoder.decode()));
  return 0;
};

tr.spec = {
  name: 'tr',
  effect: 'read' as const,
  json: false,
  description: 'Translate or delete characters',
  args: [
    {
      name: 'SET1',
      type: 'string' as const,
      description: 'set of characters to translate from',
    },
    {
      name: 'SET2',
      type: 'string' as const,
      description: 'set of characters to translate to',
    },
  ],
  flags: [
    { name: 'd', type: 'bool' as const, description: 'delete characters in SET1' },
    { name: 's', type: 'bool' as const, description: 'squeeze repeated characters in last operand' },
    { name: 'c', type: 'bool' as const, description: 'use complement of SET1' },
  ],
};
