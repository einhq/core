import type { Command } from '../../command.ts';
import type { Input } from '../../command-input.ts';
import { operands } from '../../input.ts';
import { signalExitCode } from '../../signal.ts';
import type { CmdReturn } from '../../types.ts';

/**
 * xargs, after GNU xargs: build command lines from the items on stdin and run them.
 *
 * `find /a -name '*.tmp' | xargs rm` runs `rm` with as many paths as fit in one line. Items are
 * separated by blanks and newlines, with GNU's quoting (`'…'`, `"…"`, `\`); `-0` and `-d` split on
 * one character instead and take the text literally. With no command, it runs `echo`.
 *
 * A command reads an empty stdin, not the items still to come, unless they come from `-a FILE`,
 * or the terminal with `-o`. `-P` runs several at once.
 */

class XargsUsageError extends Error {}

type Options = {
  /** One character every item ends with; undefined splits on blanks and newlines, with quoting. */
  delimiter?: string;
  maxArgs?: number;
  maxLines?: number;
  maxChars: number;
  /** Each input line is one item, run once with this string replaced by it in the command. */
  replace?: string;
  /** An item equal to this ends the input. */
  eof?: string;
  noRunIfEmpty: boolean;
  verbose: boolean;
  /** Ask on the terminal before each run, and run only on a yes. */
  interactive: boolean;
  /** Each command's stdin is the terminal. */
  openTty: boolean;
  /** Stop when a run cannot take the items -n or -L give it. */
  exit: boolean;
  /** How many runs at once; 0 is as many as there are. */
  maxProcs: number;
  argFile?: string;
  command: string[];
};

/** One event of the input: an item, or the end of a logical line, which `-L` counts. */
type Token = { item: string } | { lineEnd: true };

/** GNU's default for `-s`: how long one command line may grow. */
const MAX_CHARS = 128 * 1024;

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', '\\': '\\', '0': '\0' };

/** `-d`'s argument: one character, or a backslash escape for one (`\n`, `\x2c`, `\054`). */
const parseDelimiter = (spec: string): string => {
  if ([...spec].length === 1) return spec;
  const hex = /^\\x([0-9a-fA-F]{1,2})$/.exec(spec);
  if (hex) return String.fromCharCode(parseInt(hex[1], 16));
  const octal = /^\\([0-7]{1,3})$/.exec(spec);
  if (octal) return String.fromCharCode(parseInt(octal[1], 8));
  if (spec.length === 2 && spec[0] === '\\' && spec[1] in ESCAPES) return ESCAPES[spec[1]];
  throw new XargsUsageError(`invalid input delimiter specification ${spec}: the delimiter must be a single character or an escape sequence starting with \\.`);
};

const parseCount = (value: string, flag: string, min = 1): number => {
  if (!/^-?\d+$/.test(value)) throw new XargsUsageError(`invalid number "${value}" for -${flag} option`);
  const count = parseInt(value, 10);
  if (count < min) throw new XargsUsageError(min === 0 ? `value ${value} for -${flag} option should be >= 0` : `invalid number "${value}" for -${flag} option`);
  return count;
};

/** Short options that take a value, attached (`-n2`) or as the next word (`-n 2`). */
const SHORT_VALUE = new Set(['a', 'd', 'E', 'I', 'L', 'n', 'P', 's']);
/** Short options whose value is optional and only ever attached (`-i{}`, `-l2`, `-eEND`). */
const SHORT_OPTIONAL = new Set(['e', 'i', 'l']);
const LONG_NAMES: Record<string, string> = {
  null: '0',
  delimiter: 'd',
  'max-args': 'n',
  'max-lines': 'L',
  'max-chars': 's',
  replace: 'I',
  eof: 'E',
  'no-run-if-empty': 'r',
  verbose: 't',
  interactive: 'p',
  'open-tty': 'o',
  exit: 'x',
  'max-procs': 'P',
  'arg-file': 'a',
};
/**
 * Long options that take a value, `=` attached or as the next word. GNU's `--max-lines`,
 * `--replace` and `--eof` may go without one; here they take the next word too, as the effect
 * judge does, so the command it judges is the one that runs.
 */
const LONG_VALUE = new Set(['delimiter', 'max-args', 'max-lines', 'max-chars', 'replace', 'eof', 'max-procs', 'arg-file']);

/** The options, up to the first word that is not one: from there on it is the command and its arguments. */
const parseOptions = (args: string[]): Options => {
  const opts: Options = {
    maxChars: MAX_CHARS,
    noRunIfEmpty: false,
    verbose: false,
    interactive: false,
    openTty: false,
    exit: false,
    maxProcs: 1,
    command: [],
  };

  const apply = (letter: string, value: string | undefined): void => {
    switch (letter) {
      case '0':
        opts.delimiter = '\0';
        return;
      case 'd':
        opts.delimiter = parseDelimiter(value!);
        return;
      case 'n':
        opts.maxArgs = parseCount(value!, 'n');
        return;
      case 'L':
      case 'l':
        opts.maxLines = value === undefined ? 1 : parseCount(value, letter);
        return;
      case 's':
        opts.maxChars = parseCount(value!, 's');
        return;
      case 'I':
        opts.replace = value!;
        return;
      case 'i':
        opts.replace = value || '{}';
        return;
      case 'E':
      case 'e':
        opts.eof = value || undefined;
        return;
      case 'r':
        opts.noRunIfEmpty = true;
        return;
      case 't':
        opts.verbose = true;
        return;
      case 'p':
        opts.interactive = true;
        return;
      case 'o':
        opts.openTty = true;
        return;
      case 'x':
        opts.exit = true;
        return;
      case 'P':
        opts.maxProcs = parseCount(value!, 'P', 0);
        return;
      case 'a':
        opts.argFile = value!;
        return;
      default:
        throw new XargsUsageError(`invalid option -- '${letter}'`);
    }
  };

  let i = 0;
  for (; i < args.length; i++) {
    const word = args[i];
    if (word === '--') {
      i++;
      break;
    }
    if (!word.startsWith('-') || word === '-') break;
    if (word.startsWith('--')) {
      const eq = word.indexOf('=');
      const name = word.slice(2, eq === -1 ? undefined : eq);
      const letter = LONG_NAMES[name];
      if (!letter) throw new XargsUsageError(`unrecognized option '${word}'`);
      let value = eq === -1 ? undefined : word.slice(eq + 1);
      if (value === undefined && LONG_VALUE.has(name)) {
        if (++i >= args.length) throw new XargsUsageError(`option '--${name}' requires an argument`);
        value = args[i];
      }
      apply(letter, value);
      continue;
    }
    for (let at = 1; at < word.length; at++) {
      const letter = word[at];
      const attached = word.slice(at + 1);
      if (SHORT_VALUE.has(letter)) {
        // In a group (`-rI`), the value is attached (`-rI{}`): the effect judge takes the word
        // after a group for the command, and must find the one that runs.
        if (attached) apply(letter, attached);
        else if (at > 1) throw new XargsUsageError(`option -${letter} in a group takes its value attached: write ${word}VALUE or -${letter} VALUE`);
        else if (++i < args.length) apply(letter, args[i]);
        else throw new XargsUsageError(`option requires an argument -- '${letter}'`);
        break;
      }
      if (SHORT_OPTIONAL.has(letter)) {
        apply(letter, attached || undefined);
        break;
      }
      apply(letter, undefined);
    }
  }
  opts.command = args.slice(i);
  if (opts.command.length === 0) opts.command = ['echo'];
  return opts;
};

/**
 * The items of the input, as they arrive.
 *
 * With a delimiter, each item is the text up to it, taken literally, and ends a line. Otherwise
 * blanks and newlines separate items — or only newlines, with `lines`, leading blanks dropped —
 * and quotes and backslashes are GNU xargs's. A line that ends in a blank goes on on the next one.
 */
async function* tokens(input: Input, delimiter: string | undefined, lines: boolean): AsyncGenerator<Token> {
  const decoder = new TextDecoder();
  let item: string | undefined;
  let quote: string | undefined;
  let escaped = false;
  let trailingBlank = false;
  let lineHasItems = false;

  const text = async function* (): AsyncGenerator<string> {
    for await (const chunk of input.chunks()) yield decoder.decode(chunk, { stream: true });
    yield decoder.decode();
  };

  for await (const piece of text()) {
    for (const char of piece) {
      if (delimiter !== undefined) {
        if (char === delimiter) {
          yield { item: item ?? '' };
          yield { lineEnd: true };
          item = undefined;
        } else {
          item = (item ?? '') + char;
        }
        continue;
      }
      if (escaped) {
        item = (item ?? '') + char;
        escaped = false;
        continue;
      }
      if (quote) {
        if (char === quote) quote = undefined;
        else if (char === '\n') {
          throw new XargsUsageError(`unmatched ${quote === "'" ? 'single' : 'double'} quote; by default quotes are special to xargs unless you use the -0 option`);
        } else item = (item ?? '') + char;
        continue;
      }
      if (char === '\n') {
        if (item !== undefined) {
          yield { item };
          lineHasItems = true;
        }
        item = undefined;
        if (lineHasItems && (lines || !trailingBlank)) {
          yield { lineEnd: true };
          lineHasItems = false;
        }
        trailingBlank = false;
        continue;
      }
      if (char === ' ' || char === '\t') {
        trailingBlank = true;
        if (lines) {
          if (item !== undefined) item += char;
        } else if (item !== undefined) {
          yield { item };
          lineHasItems = true;
          item = undefined;
        }
        continue;
      }
      trailingBlank = false;
      if (char === '\\') {
        escaped = true;
        item ??= '';
      } else if (char === "'" || char === '"') {
        quote = char;
        item ??= '';
      } else {
        item = (item ?? '') + char;
      }
    }
  }
  if (quote) throw new XargsUsageError(`unmatched ${quote === "'" ? 'single' : 'double'} quote; by default quotes are special to xargs unless you use the -0 option`);
  if (item !== undefined) {
    yield { item };
    lineHasItems = true;
  }
  if (lineHasItems) yield { lineEnd: true };
}

/** The stdin a command gets instead of xargs's own, as GNU's does. */
const EMPTY_STDIN = ' < /dev/null';

const shellQuote = (word: string): string => `'${word.replaceAll("'", "'\\''")}'`;

/** How much of a command line a word takes: itself and the separator after it. */
const lineLength = (words: string[]): number => words.reduce((sum, word) => sum + word.length + 1, 0);

export const xargs = async (cmd: Command): CmdReturn => {
  let opts: Options;
  try {
    opts = parseOptions(cmd.args);
  } catch (err) {
    if (!(err instanceof XargsUsageError)) throw err;
    await cmd.writeError(`xargs: ${err.message}\n`);
    return 1;
  }

  const baseLength = lineLength(opts.command);
  if (baseLength > opts.maxChars) {
    await cmd.writeError('xargs: argument list too long\n');
    return 1;
  }
  for (const [needs, flag] of [[opts.interactive, 'p'], [opts.openTty, 'o']] as const) {
    if (needs && !cmd.tty) {
      await cmd.writeError(`xargs: -${flag}: no terminal to read from\n`);
      return 1;
    }
  }
  // A run that cannot take the items -n or -L give it ends xargs, rather than taking fewer.
  const exitOnSplit = opts.maxLines !== undefined || (opts.exit && opts.maxArgs !== undefined);

  let status = 0;
  let stopped: number | undefined;
  /** The runs going on, with -P. */
  const running = new Set<Promise<void>>();

  /** Whether the answer to -p's question on the terminal is yes. */
  const confirmed = async (words: string[]): Promise<boolean> => {
    try {
      return /^[yY]/.test(await cmd.prompt(`${words.join(' ')} ?...`, undefined, undefined, { terminal: true }));
    } catch (err) {
      if (err instanceof Error && err.message === 'EOT') return false;
      throw err;
    }
  };

  /** Run one command line to its end; what it exits with decides whether xargs goes on, as GNU's does. */
  const runLine = async (words: string[]): Promise<void> => {
    const stdin = opts.argFile === undefined && !opts.openTty ? EMPTY_STDIN : '';
    const code = await cmd.executeInline(words.map(shellQuote).join(' ') + stdin, { terminalStdin: opts.openTty });
    if (cmd.interrupted) return;
    if (code === 255) {
      await cmd.writeError(`xargs: ${words[0]}: exited with status 255; aborting\n`);
      stopped = 124;
    } else if (code === 126 || code === 127) {
      stopped = code;
    } else if (code > 128) {
      await cmd.writeError(`xargs: ${words[0]}: terminated by signal ${code - 128}\n`);
      stopped = 125;
    } else if (code !== 0) {
      status = 123;
    }
  };

  /**
   * Start one command line once fewer than -P runs are going on, after asking with -p (whose
   * question is the line, as -t shows it). With -P 1 it has ended when this returns.
   */
  const run = async (words: string[]): Promise<void> => {
    while (opts.maxProcs !== 0 && running.size >= opts.maxProcs) await Promise.race(running);
    if (stopped !== undefined || cmd.interrupted) return;
    if (opts.interactive) {
      if (!await confirmed(words)) return;
    } else if (opts.verbose) {
      await cmd.writeError(`${words.join(' ')}\n`);
    }
    const done: Promise<void> = runLine(words).finally(() => running.delete(done));
    running.add(done);
    if (opts.maxProcs === 1) await done;
  };

  // `-a FILE` is opened through the operand reader, which closes it when its iterator returns.
  let input: Input = cmd.stdin;
  let files: AsyncIterator<Input> | undefined;
  if (opts.argFile !== undefined) {
    files = operands(cmd, [opts.argFile], { error: (file, why) => `xargs: ${file}: ${why}` })[Symbol.asyncIterator]();
    const first = await files.next();
    if (first.done) return 1;
    input = first.value;
  }

  let ran = false;
  let batch: string[] = [];
  let batchLength = baseLength;
  let batchLines = 0;

  const flush = async (): Promise<void> => {
    if (batch.length === 0) return;
    const words = [...opts.command, ...batch];
    batch = [];
    batchLength = baseLength;
    batchLines = 0;
    ran = true;
    await run(words);
  };

  try {
    for await (const token of tokens(input, opts.delimiter, opts.replace !== undefined)) {
      if (stopped !== undefined || cmd.interrupted) break;
      if ('lineEnd' in token) {
        if (batch.length > 0 && opts.maxLines !== undefined && ++batchLines >= opts.maxLines) await flush();
        continue;
      }
      const { item } = token;
      if (opts.eof !== undefined && opts.delimiter === undefined && item === opts.eof) break;
      if (opts.replace !== undefined) {
        const words = opts.command.map((word) => word.replaceAll(opts.replace!, item));
        if (lineLength(words) > opts.maxChars) throw new XargsUsageError('argument line too long');
        ran = true;
        await run(words);
        continue;
      }
      const length = item.length + 1;
      if (baseLength + length > opts.maxChars) throw new XargsUsageError('argument line too long');
      if (batchLength + length > opts.maxChars) {
        if (exitOnSplit) throw new XargsUsageError('argument list too long');
        await flush();
      }
      if (stopped !== undefined) break;
      batch.push(item);
      batchLength += length;
      if (opts.maxArgs !== undefined && batch.length >= opts.maxArgs) await flush();
    }
    if (stopped === undefined && !cmd.interrupted) {
      await flush();
      // With nothing read, the command runs once anyway, as GNU's does; not with -r or -I.
      if (!ran && !opts.noRunIfEmpty && opts.replace === undefined) await run(opts.command);
    }
    await Promise.all(running);
  } catch (err) {
    if (!(err instanceof XargsUsageError)) throw err;
    await cmd.writeError(`xargs: ${err.message}\n`);
    return 1;
  } finally {
    await Promise.allSettled(running);
    await files?.return?.(undefined);
  }

  if (cmd.interrupted) return signalExitCode(cmd.signal ?? 'SIGINT');
  return stopped ?? status;
};

xargs.spec = {
  name: 'xargs',
  effect: 'read' as const,
  json: false,
  description: 'Run a command with the items read from stdin as its arguments, as GNU xargs does: as many per run as fit, ' +
    'or -n per run, or one input line per run with -L, or once per line with -I replacing a string in the command. ' +
    'Items are separated by blanks and newlines, with quotes and backslashes as GNU has them; -0 and -d split on one character instead. ' +
    'The command reads an empty stdin, or the terminal with -o; with no command it is echo. -P runs several at once, -p asks before each run. ' +
    'Exits 123 when a run failed, 124 when one exited 255, 125 when one was killed, 126 or 127 when one could not run',
  args: [
    {
      name: 'command',
      type: 'command' as const,
      description: 'the command to run and its first arguments; the items follow them (default: echo)',
      optional: true,
      variadic: true,
      runs: true,
    },
  ],
  // Each flag twice, long and short with the same help, so a tool schema offers the long one only.
  flags: ([
    ['null', '0', 'bool', 'items end with a NUL character, as find -print0 writes them; quotes are not special'],
    ['delimiter', 'd', 'string', 'items end with this character, such as , or \\n; quotes are not special'],
    ['max-args', 'n', 'string', 'at most this many items per run'],
    ['max-lines', 'L', 'string', 'at most this many input lines per run'],
    ['max-chars', 's', 'string', 'at most this many characters per command line (default 131072)'],
    ['replace', 'I', 'string', 'run once per input line, with this string in the command replaced by the line, as -I {}'],
    ['eof', 'E', 'string', 'an item equal to this ends the input'],
    ['no-run-if-empty', 'r', 'bool', 'run nothing when stdin is empty'],
    ['verbose', 't', 'bool', 'write each command line to stderr before running it'],
    ['interactive', 'p', 'bool', 'ask on the terminal before each run, and run it only on an answer starting with y'],
    ['open-tty', 'o', 'bool', 'each command reads the terminal as its stdin, for an interactive one such as edit'],
    ['exit', 'x', 'bool', 'with -n, stop when the items a run is given do not fit in -s, rather than giving it fewer; -L always does'],
    ['max-procs', 'P', 'string', 'run up to this many commands at once (default 1); 0 runs as many as there are'],
    ['arg-file', 'a', 'path', 'read the items from this file; the command then reads stdin'],
  ] as const).flatMap(([long, short, type, description]) => [{ name: long, type, description }, { name: short, type, description }]),
  examples: [
    "find /home/anna/staging -name '*.tmp' -print0 | xargs -0 rm",
    'ls /archive/people | xargs -I {} info /archive/people/{}',
  ],
  returns: 'what the commands it runs write; xargs itself writes text only',
};
