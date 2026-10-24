import { parseArgs as stdParseArgs } from '@std/cli/parse-args';

type ArgsOptions = Parameters<typeof stdParseArgs>[1];

/** Normalize a `string | string[] | undefined` option list to a flat array. */
const list = (value: unknown): string[] => {
  if (typeof value === 'string') {
    return [value];
  }

  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
};

/**
 * The options that take a value, alias groups included: with
 * `alias: { d: 'delimiter' }` and `string: ['delimiter']`, `-d` takes one too.
 */
const valueTakingNames = (options: ArgsOptions): Set<string> => {
  const groups: string[][] = [];

  for (const [name, aliases] of Object.entries(options?.alias ?? {})) {
    groups.push([name, ...list(aliases)]);
  }

  const takesValue = new Set([...list(options?.string), ...list(options?.collect)]);
  const boolean = new Set(list(options?.boolean));

  for (const group of groups) {
    if (group.some((name) => takesValue.has(name))) {
      for (const name of group) {
        takesValue.add(name);
      }
    }
  }

  return new Set([...takesValue].filter((name) => !boolean.has(name)));
};

/** The single-letter ones among `valueTakingNames`. */
const valueTakingLetters = (names: Set<string>): Set<string> => new Set([...names].filter((name) => name.length === 1));

/**
 * Attach an empty value to the option before it, so `--text ''` becomes `--text=` and `-t ''`
 * becomes `-t=`.
 *
 * `@std/cli` does not take an empty next argument as an option's value: it sets the option to
 * `''` and keeps the empty argument as a positional, so `file-set-description --text '' <file>`
 * would read `''` as the file, where the caller means "clear it".
 */
const attachEmptyValues = (args: string[], names: Set<string>): string[] => {
  if (names.size === 0) {
    return args;
  }

  const out: string[] = [];
  let literal = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    literal ||= arg === '--';
    const name = literal ? undefined : /^--?([^-=][^=]*)$/.exec(arg)?.[1];
    if (name !== undefined && names.has(name) && (arg.startsWith('--') || name.length === 1) && args[i + 1] === '') {
      out.push(`${arg}=`);
      i++;
      continue;
    }
    out.push(arg);
  }

  return out;
};

/**
 * Split values attached to a short option off into their own argument, so
 * `-d:` becomes `-d` `:` and `-xvffile.tar` becomes `-xvf` `file.tar`.
 *
 * `@std/cli` only does this when the value is a number, so `-f2` parses but
 * `-d:` sets the delimiter to `''` and an option named `:` to true. An empty
 * delimiter is not an error either — `line.split('')` cuts the line into
 * characters — so `cut -d" " -f2` would return the second *character*.
 * `-d=x` and a value in the next argument are left to `@std/cli`, which
 * already handles both.
 */
const splitAttachedValues = (args: string[], letters: Set<string>): string[] => {
  if (letters.size === 0) {
    return args;
  }

  const out: string[] = [];
  let literal = false;

  for (const arg of args) {
    if (literal || !/^-[A-Za-z]/.test(arg)) {
      literal ||= arg === '--';
      out.push(arg);
      continue;
    }

    // A short-option cluster: everything after the first option that takes a
    // value is that value, whatever it looks like.
    const at = [...arg].findIndex((c, i) => i > 0 && letters.has(c));
    const value = at === -1 ? '' : arg.slice(at + 1);

    if (at === -1 || value === '' || value.startsWith('=')) {
      out.push(arg);
      continue;
    }

    out.push(arg.slice(0, at + 1), value);
  }

  return out;
};

/**
 * Every declared boolean `x` is negatable as `--no-x`, unless the command declares `no-x` itself.
 *
 * `@std/cli` reads `--no-x` for a boolean that is not `negatable` as an option named `no-x`, which
 * takes the argument after it as its value: `ls --no-a /var` would drop `/var`.
 */
const withNegatableBooleans = (options: ArgsOptions): ArgsOptions => {
  const boolean = list(options?.boolean);
  if (boolean.length === 0) {
    return options;
  }

  const negatable = boolean.filter((name) => !boolean.includes(`no-${name}`));
  return { ...options, negatable: [...list(options?.negatable), ...negatable] };
};

/**
 * `@std/cli`'s parseArgs, with values attached to a short option understood and every declared
 * boolean negatable. Same signature — use this everywhere instead of importing `@std/cli` directly.
 */
export const parseArgs = ((args: string[], options?: ArgsOptions) => {
  const names = valueTakingNames(options);
  return stdParseArgs(
    splitAttachedValues(attachEmptyValues(args, names), valueTakingLetters(names)),
    withNegatableBooleans(options),
  );
}) as typeof stdParseArgs;

/**
 * Collect the flags a caller passed that the command never declared, for
 * `parseArgs`'s `unknown` hook.
 *
 * Without it an undeclared flag is not merely ignored — `parseArgs` reads the
 * argument after it as its value, so `device-link -f /albums` consumes the path
 * into a flag named `f` and leaves `_` empty. The command then reports `missing
 * file path` about a path that was right there, which sends the reader looking
 * in the wrong place entirely. Naming the flag is the honest error.
 *
 * Positionals reach the same hook with no `key`; those pass through untouched.
 * So does anything after `--`, which `parseArgs` never offers here. A short
 * cluster reports its raw argument once however many letters are in it: `-1234`
 * fires four times and is reported as `-1234`.
 */
export const collectUnknownFlags = (into: string[]) => (arg: string, key?: string): boolean => {
  if (key === undefined) {
    return true;
  }

  if (!into.includes(arg)) {
    into.push(arg);
  }

  return false;
};

/** The subset of a command this needs: enough to name itself and write to stderr. */
type FlagErrorSink = {
  readonly name: string;
  writeError(data: string): Promise<void>;
};

/**
 * Report whatever `collectUnknownFlags` gathered. True means the caller should stop —
 * `if (await reportUnknownFlags(cmd, unknown)) return 1;`.
 */
export const reportUnknownFlags = async (cmd: FlagErrorSink, unknown: string[]): Promise<boolean> => {
  if (unknown.length === 0) {
    return false;
  }

  await cmd.writeError(`${cmd.name}: unknown flag ${unknown.join(' ')}\n`);
  return true;
};

/**
 * Rewrite the obsolescent `-NUM` count form to `-<letter> NUM`, for the handful
 * of commands that accept it: `head -5` means `head -n 5`, `tail -20` means
 * `tail -n 20`.
 *
 * It has to happen before parsing, because `@std/cli` reads `-5` as a short
 * option named `5` and `-12` as the cluster `-1 -2` — neither of which any
 * command declares — and takes the operand as its value: `head -5 file` would
 * parse as `{"5": "file"}` with an empty `_`.
 *
 * Only a bare run of digits qualifies. `-5.5` is not a line count, and anything
 * after `--` is an operand.
 */
export const expandCountFlag = (args: string[], letter = 'n'): string[] => {
  const out: string[] = [];
  let literal = false;

  for (const arg of args) {
    if (literal) {
      out.push(arg);
      continue;
    }

    if (arg === '--') {
      literal = true;
      out.push(arg);
      continue;
    }

    if (/^-\d+$/.test(arg)) {
      out.push(`-${letter}`, arg.slice(1));
      continue;
    }

    out.push(arg);
  }

  return out;
};
