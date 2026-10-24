/**
 * wc: the newline, word, character and byte counts of each FILE, followed by its name, and a
 * `total` line when there are several. Stdin is counted when there are no FILEs, and for `-`.
 *
 * The counts come in the order lines, words, characters, bytes; -l, -w, -m and -c pick which, and
 * without any of them it is lines, words and bytes. As in GNU wc, the columns are as wide as the
 * digits of the files' total size, at least 7 when stdin is among the inputs, and a single count
 * of a single input is not padded at all.
 */

import { collectUnknownFlags, parseArgs, reportUnknownFlags } from '../../../../lib/args/mod.ts';
import type { Command } from '../../command.ts';
import { operands } from '../../input.ts';
import { signalExitCode } from '../../signal.ts';
import { CmdReturn } from '../../types.ts';

type Counts = { lines: number; words: number; chars: number; bytes: number };

/** Counts a byte stream chunk by chunk; a word or a character split across two chunks counts once. */
export class Counter {
  readonly counts: Counts = { lines: 0, words: 0, chars: 0, bytes: 0 };
  private decoder = new TextDecoder();
  private inWord = false;

  add(chunk: Uint8Array) {
    this.counts.bytes += chunk.length;
    this.text(this.decoder.decode(chunk, { stream: true }));
  }

  end() {
    this.text(this.decoder.decode());
  }

  private text(text: string) {
    if (text === '') return;
    for (const char of text) {
      this.counts.chars++;
      if (char === '\n') this.counts.lines++;
    }
    for (const match of text.matchAll(/\S+/g)) {
      if (match.index !== 0 || !this.inWord) this.counts.words++;
    }
    this.inWord = /\S$/.test(text);
  }
}

export const wc = async (cmd: Command): CmdReturn => {
  const unknown: string[] = [];
  const flags = parseArgs(cmd.args, {
    alias: {
      c: 'bytes',
      m: 'chars',
      l: 'lines',
      w: 'words',
    },
    boolean: ['c', 'm', 'l', 'w'],
    unknown: collectUnknownFlags(unknown),
  });
  if (await reportUnknownFlags(cmd, unknown)) return 1;

  const picked = (['lines', 'words', 'chars', 'bytes'] as const).filter((key) => flags[key]);
  const shown = picked.length > 0 ? picked : (['lines', 'words', 'bytes'] as const);
  const files = flags._.length > 0 ? flags._.map(String) : ['-'];

  const results: { name: string; counts: Counts }[] = [];
  let fileBytes = 0;
  const inputs = operands(cmd, files);
  for await (const input of inputs) {
    const counter = new Counter();
    for await (const chunk of input.chunks()) counter.add(chunk);
    counter.end();
    if (input.name !== '-') fileBytes += counter.counts.bytes;
    results.push({ name: input.name, counts: counter.counts });
  }
  if (cmd.interrupted) return signalExitCode(cmd.signal ?? 'SIGINT');

  const width = files.length === 1 && shown.length === 1 ? 1 : Math.max(String(fileBytes).length, files.includes('-') ? 7 : 1);
  const line = (counts: Counts, name: string) => {
    const columns = shown.map((key) => String(counts[key]).padStart(width));
    if (flags._.length > 0) columns.push(name);
    return `${columns.join(' ')}\n`;
  };

  let out = results.map((result) => line(result.counts, result.name)).join('');
  if (files.length > 1) {
    const total: Counts = { lines: 0, words: 0, chars: 0, bytes: 0 };
    for (const { counts } of results) {
      for (const key of shown) total[key] += counts[key];
    }
    out += line(total, 'total');
  }
  await cmd.write(out);
  return inputs.failed ? 1 : 0;
};

wc.spec = {
  name: 'wc',
  effect: 'read' as const,
  json: false,
  description: 'Print newline, word, and byte counts of files or stdin',
  args: [
    {
      name: 'FILE',
      type: 'path' as const,
      description: 'files to count, each on a line of its own and then a total (stdin if omitted, or for -)',
      variadic: true,
    },
  ],
  flags: [
    { name: 'c', type: 'bool' as const, description: 'print the byte counts' },
    { name: 'm', type: 'bool' as const, description: 'print the character counts' },
    { name: 'l', type: 'bool' as const, description: 'print the newline counts' },
    { name: 'w', type: 'bool' as const, description: 'print the word counts' },
  ],
  examples: [
    'wc -l /archive/albums/Exempelalbum_2019/files/notes.txt',
  ],
  returns: 'the counts asked for, then the file name; a total line when there are several files.',
};
