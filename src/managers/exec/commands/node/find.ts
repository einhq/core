import { dirname, resolve } from '@std/path';
import type { FindEntry } from '../../../../lib/api/node.ts';
import { SYSTEM_TIME_ZONE } from '../../../../lib/datetime/mod.ts';
import { globToRegex } from '../../../../lib/glob/glob.ts';
import type { Node } from '../../../../vfs/node.ts';
import type { GroupAttrs } from '../../../../vfs/types/group.ts';
import type { UserAttrs } from '../../../../vfs/types/user.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

/**
 * find, after GNU find: starting points, then an expression of tests, operators and actions.
 *
 * `find /albums -name '*.jpg' -type f` prints each match under `/albums`, the starting point
 * included, at depth 0. The tests the spec declares as flags may also be spelled `--name=GLOB`,
 * which is how help, completion and the assistant's tool call write them; any other word the
 * expression does not know is an error, not a no-op that lists everything.
 *
 * In JSON mode the answer is the entries `-print` selected. An expression that asks for text —
 * `-printf`, `-print0`, or `-exec`, whose commands write their own output — writes text instead.
 */

/** One node as the expression sees it: the path as printed, its name, the node, and its depth. */
type Candidate = {
  path: string;
  /** The starting point it was found under, as printed: `%P` is the path without it. */
  start: string;
  vfsPath: string;
  name: string;
  node: Node;
  childCount: number;
  depth: number;
};

/** What evaluating the expression on a node asks of the walk. */
type Control = { prune: boolean; quit: boolean };

/** A `-printf` format: literal text, and directives with their field width and flags. */
type FormatPiece = string | { spec: string; directive: string };

type Expr =
  | { op: 'and' | 'or'; left: Expr; right: Expr }
  | { op: 'not'; expr: Expr }
  | { op: 'test'; test: (c: Candidate) => boolean; types?: string[] }
  | { op: 'print' | 'print0' | 'prune' | 'quit' | 'true' | 'delete' }
  | { op: 'printf'; format: FormatPiece[] }
  | { op: 'exec'; argv: string[] }
  | { op: 'execBatch'; argv: string[]; paths: string[] };

class FindUsageError extends Error {}

/** `-type` letters, as GNU spells them, for the node types they stand for. */
const TYPE_LETTERS: Record<string, string> = { f: 'file', d: 'directory', l: 'softlink', c: 'null' };
const LETTER_OF_TYPE: Record<string, string> = { file: 'f', directory: 'd', softlink: 'l', null: 'c' };

const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

/** `-size` units; a bare number counts 512-byte blocks, as GNU does. */
const SIZE_UNITS: Record<string, number> = { c: 1, w: 2, b: 512, k: 1024, M: 1024 ** 2, G: 1024 ** 3 };

/** How many paths one `-exec … {} +` run takes before the next one starts. */
const BATCH_SIZE = 256;

/** GNU's numeric argument: `+n` more than n, `-n` less than n, `n` exactly n. */
const compareNumber = (word: string, primary: string): (value: number) => boolean => {
  const match = /^([+-]?)(\d+)$/.exec(word);
  if (!match) throw new FindUsageError(`invalid argument \`${word}' to \`${primary}'`);
  const n = parseInt(match[2], 10);
  if (match[1] === '+') return (value) => value > n;
  if (match[1] === '-') return (value) => value < n;
  return (value) => value === n;
};

const parseDepth = (word: string, primary: string): number => {
  if (!/^\d+$/.test(word)) throw new FindUsageError(`invalid argument \`${word}' to \`${primary}'`);
  return parseInt(word, 10);
};

const modtime = (node: Node): number => node.props.modtime.timestamp;

const fileSize = (node: Node): number => Number((node.attrs as { size?: unknown }).size ?? 0);

const shellQuote = (word: string): string => `'${word.replaceAll("'", "'\\''")}'`;

/** Whether an expression prints or runs something: then it is not wrapped in `-print`. `-prune` and `-quit` do not count. */
const hasAction = (expr: Expr): boolean => {
  switch (expr.op) {
    case 'and':
    case 'or':
      return hasAction(expr.left) || hasAction(expr.right);
    case 'not':
      return hasAction(expr.expr);
    case 'test':
    case 'true':
    case 'prune':
    case 'quit':
      return false;
    default:
      return true;
  }
};

/** Whether any node of the expression satisfies `is`. */
const some = (expr: Expr, is: (e: Expr) => boolean): boolean => {
  if (is(expr)) return true;
  if (expr.op === 'and' || expr.op === 'or') return some(expr.left, is) || some(expr.right, is);
  if (expr.op === 'not') return some(expr.expr, is);
  return false;
};

/**
 * The node types every printing match must be, when a `-type` test is a conjunct that runs before
 * any action. Undefined when the expression does not narrow it that way.
 */
const requiredTypes = (expr: Expr): string[] | undefined => {
  if (expr.op === 'test') return expr.types;
  if (expr.op !== 'and') return undefined;
  const left = requiredTypes(expr.left);
  const right = hasAction(expr.left) ? undefined : requiredTypes(expr.right);
  if (left && right) return left.filter((type) => right.includes(type));
  return left ?? right;
};

/** The tests the spec declares as flags: `--name=GLOB` and `--name GLOB` are `-name GLOB`. */
const LONG_SPELLINGS = new Set(['name', 'iname', 'type', 'maxdepth', 'mindepth']);

const longToGnu = (args: string[]): string[] =>
  args.flatMap((arg) => {
    const match = /^--([a-z]+)(?:=([\s\S]*))?$/.exec(arg);
    if (!match || !LONG_SPELLINGS.has(match[1])) return [arg];
    return match[2] === undefined ? [`-${match[1]}`] : [`-${match[1]}`, match[2]];
  });

/** A word that starts or continues an expression, rather than naming a starting point. */
const isExpressionWord = (word: string): boolean => (word.startsWith('-') && word !== '-') || word === '(' || word === ')' || word === '!';

/** The account names by uid and the group names by gid, as far as the caller may list them. */
type Owners = { users: Map<number, string>; groups: Map<number, string> };

const loadOwners = async (cmd: Command): Promise<Owners> => {
  const owners: Owners = { users: new Map(), groups: new Map() };
  try {
    for (const user of await cmd.sys.vfs.children<UserAttrs>(cmd.access, cmd.env.USERS_PATH)) owners.users.set(user.node.attrs.uid, user.name);
  } catch { /* users not accessible */ }
  try {
    for (const group of await cmd.sys.vfs.children<GroupAttrs>(cmd.access, cmd.env.GROUPS_PATH)) owners.groups.set(group.node.attrs.gid, group.name);
  } catch { /* groups not accessible */ }
  return owners;
};

/** `-user` and `-group`'s argument: a name, or failing that a number. */
const ownerId = (names: Map<number, string>, word: string, message: string): number => {
  for (const [id, name] of names) if (name === word) return id;
  if (/^\d+$/.test(word)) return parseInt(word, 10);
  throw new FindUsageError(`'${word}' ${message}`);
};

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', a: '\x07', b: '\b', f: '\f', v: '\v', '\\': '\\', '0': '\0' };
const DIRECTIVES = new Set([...'%pfhPdsymugUGtc']);
const TIME_DIRECTIVES = new Set(['T', 'C', 'B']);
const TIME_FIELDS = new Set([...'@YymdHMSFTDab+']);

/** A `-printf` format, parsed: GNU's backslash escapes and the directives it knows; anything else is an error. */
const parseFormat = (format: string): FormatPiece[] => {
  const pieces: FormatPiece[] = [];
  let text = '';
  for (let i = 0; i < format.length; i++) {
    const char = format[i];
    if (char === '\\') {
      const next = format[++i];
      if (next === undefined) {
        text += '\\';
      } else if (next === 'c') {
        break;
      } else if (/[0-7]/.test(next) && /^[0-7]{3}/.test(format.slice(i))) {
        text += String.fromCharCode(parseInt(format.slice(i, i + 3), 8));
        i += 2;
      } else if (next in ESCAPES) {
        text += ESCAPES[next];
      } else {
        throw new FindUsageError(`unrecognized escape \`\\${next}' in -printf`);
      }
      continue;
    }
    if (char !== '%') {
      text += char;
      continue;
    }
    const match = /^([-+ #0]*\d*(?:\.\d+)?)([a-zA-Z%@+])([a-zA-Z@+])?/.exec(format.slice(i + 1));
    if (!match) throw new FindUsageError('incomplete format directive at the end of -printf');
    const [, spec, letter, field] = match;
    if (TIME_DIRECTIVES.has(letter)) {
      if (!field || !TIME_FIELDS.has(field)) throw new FindUsageError(`unrecognized format directive \`%${letter}${field ?? ''}' in -printf`);
      pieces.push(text, { spec, directive: letter + field });
      i += spec.length + 2;
    } else {
      if (!DIRECTIVES.has(letter)) throw new FindUsageError(`unrecognized format directive \`%${letter}' in -printf`);
      pieces.push(text, letter === '%' ? '%' : { spec, directive: letter });
      i += spec.length + 1;
    }
    text = '';
  }
  pieces.push(text);
  return pieces.filter((piece) => piece !== '');
};

const pad2 = (n: number): string => `${n}`.padStart(2, '0');
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** One field of a timestamp, as `-printf`'s `%Tk` gives it, in the system's time zone. */
const timeField = (timestamp: number, field: string): string => {
  const at = Temporal.Instant.fromEpochMilliseconds(timestamp).toZonedDateTimeISO(SYSTEM_TIME_ZONE);
  const fraction = `${timestamp % 1000}`.padStart(3, '0').padEnd(10, '0');
  const seconds = `${pad2(at.second)}.${fraction}`;
  switch (field) {
    case '@':
      return `${Math.floor(timestamp / 1000)}.${fraction}`;
    case 'Y':
      return `${at.year}`;
    case 'y':
      return pad2(at.year % 100);
    case 'm':
      return pad2(at.month);
    case 'd':
      return pad2(at.day);
    case 'H':
      return pad2(at.hour);
    case 'M':
      return pad2(at.minute);
    case 'S':
      return seconds;
    case 'F':
      return `${at.year}-${pad2(at.month)}-${pad2(at.day)}`;
    case 'T':
      return `${pad2(at.hour)}:${pad2(at.minute)}:${seconds}`;
    case 'D':
      return `${pad2(at.month)}/${pad2(at.day)}/${pad2(at.year % 100)}`;
    case 'a':
      return WEEKDAYS[at.dayOfWeek - 1];
    case 'b':
      return MONTHS[at.month - 1];
    default: // '+'
      return `${timeField(timestamp, 'F')}+${timeField(timestamp, 'T')}`;
  }
};

/** A timestamp as `%t` and `%c` give it: ctime's layout, with GNU's fraction of a second. */
const ctime = (timestamp: number): string =>
  `${timeField(timestamp, 'a')} ${timeField(timestamp, 'b')} ${`${parseInt(timeField(timestamp, 'd'), 10)}`.padStart(2)} ` +
  `${timeField(timestamp, 'T')} ${timeField(timestamp, 'Y')}`;

/** A field padded to a printf width: `-` pads on the right, `0` with zeros for a number. */
const applyWidth = (value: string, spec: string): string => {
  const match = /^([-+ #0]*)(\d*)(?:\.(\d+))?$/.exec(spec)!;
  const [, flags, width, precision] = match;
  const out = precision !== undefined ? value.slice(0, parseInt(precision, 10)) : value;
  const n = width ? parseInt(width, 10) : 0;
  if (flags.includes('-')) return out.padEnd(n);
  if (flags.includes('0') && /^\d+$/.test(out)) return out.padStart(n, '0');
  return out.padStart(n);
};

type Parsed = { expr: Expr; maxdepth: number; mindepth: number; depthFirst: boolean; trailing: string[] };

/** Parse the expression words, resolving `-newer`'s reference node and `-user`'s name on the way. */
const parseExpression = async (cmd: Command, words: string[], owners: () => Promise<Owners>): Promise<Parsed> => {
  let pos = 0;
  let maxdepth = Infinity;
  let mindepth = 0;
  let depthFirst = false;

  const argument = (primary: string): string => {
    if (pos >= words.length) throw new FindUsageError(`missing argument to \`${primary}'`);
    return words[pos++];
  };

  const primary = async (): Promise<Expr> => {
    const word = words[pos++];
    switch (word) {
      case '-name':
      case '-iname': {
        const regex = globToRegex(argument(word));
        const re = word === '-iname' ? new RegExp(regex.source, 'i') : regex;
        return { op: 'test', test: (c) => re.test(c.name) };
      }
      case '-path':
      case '-ipath':
      case '-wholename':
      case '-iwholename': {
        const regex = globToRegex(argument(word));
        const re = word.startsWith('-i') ? new RegExp(regex.source, 'i') : regex;
        return { op: 'test', test: (c) => re.test(c.path) };
      }
      case '-regex':
      case '-iregex': {
        const source = argument(word);
        let re: RegExp;
        try {
          // Matched against the whole path, as GNU does; the syntax is JavaScript's.
          re = new RegExp(`^(?:${source})$`, word === '-iregex' ? 'i' : '');
        } catch (err) {
          throw new FindUsageError(`invalid regular expression \`${source}': ${err instanceof Error ? err.message : String(err)}`);
        }
        return { op: 'test', test: (c) => re.test(c.path) };
      }
      case '-type': {
        const types = argument(word).split(',').filter(Boolean).map((type) => TYPE_LETTERS[type] ?? type);
        if (types.length === 0) throw new FindUsageError(`missing argument to \`-type'`);
        return { op: 'test', test: (c) => types.includes(c.node.type), types };
      }
      case '-empty':
        return { op: 'test', test: (c) => c.node.type === 'file' ? fileSize(c.node) === 0 && c.childCount === 0 : c.childCount === 0 };
      case '-size': {
        const arg = argument(word);
        const match = /^([+-]?\d+)([cwbkMG]?)$/.exec(arg);
        if (!match) throw new FindUsageError(`invalid argument \`${arg}' to \`-size'`);
        const unit = SIZE_UNITS[match[2] || 'b'];
        const matches = compareNumber(match[1], word);
        // Rounded up to whole units, as GNU does: `-size -1M` is an empty file only.
        return { op: 'test', test: (c) => matches(Math.ceil(fileSize(c.node) / unit)) };
      }
      case '-user':
      case '-uid': {
        const arg = argument(word);
        const uid = word === '-uid' ? parseDepth(arg, word) : ownerId((await owners()).users, arg, 'is not the name of a known user');
        return { op: 'test', test: (c) => c.node.props.uid === uid };
      }
      case '-group':
      case '-gid': {
        const arg = argument(word);
        const gid = word === '-gid' ? parseDepth(arg, word) : ownerId((await owners()).groups, arg, 'is not the name of an existing group');
        return { op: 'test', test: (c) => c.node.props.gid === gid };
      }
      case '-newer': {
        const ref = argument(word);
        let since: number;
        try {
          since = modtime(await cmd.sys.vfs.get(cmd.access, resolve(cmd.cwd, ref)));
        } catch {
          throw new FindUsageError(`'${ref}': No such file or directory`);
        }
        return { op: 'test', test: (c) => modtime(c.node) > since };
      }
      case '-mmin':
      case '-mtime': {
        const unit = word === '-mmin' ? MINUTE : DAY;
        const matches = compareNumber(argument(word), word);
        const now = Date.now();
        return { op: 'test', test: (c) => matches(Math.floor((now - modtime(c.node)) / unit)) };
      }
      case '-maxdepth':
        maxdepth = parseDepth(argument(word), word);
        return { op: 'true' };
      case '-mindepth':
        mindepth = parseDepth(argument(word), word);
        return { op: 'true' };
      case '-depth':
        depthFirst = true;
        return { op: 'true' };
      case '-true':
        return { op: 'true' };
      case '-false':
        return { op: 'not', expr: { op: 'true' } };
      case '-print':
      case '-print0':
      case '-prune':
      case '-quit':
        return { op: word.slice(1) as 'print' | 'print0' | 'prune' | 'quit' };
      case '-delete':
        // Children go before their directory, or it would not be empty when its turn comes.
        depthFirst = true;
        return { op: 'delete' };
      case '-printf':
        return { op: 'printf', format: parseFormat(argument(word)) };
      case '-exec': {
        // The command ends at `;`, or at `+` right after `{}` to take many paths per run. A `+`
        // anywhere else is refused rather than passed on, so the command run is the one the
        // effect judge saw: it ends a command at the first `;` or `+`.
        const end = words.findIndex((w, at) => at >= pos && (w === ';' || w === '+'));
        if (end === -1) throw new FindUsageError("missing argument to `-exec'");
        const argv = words.slice(pos, end);
        pos = end + 1;
        if (argv.length === 0) throw new FindUsageError("missing argument to `-exec'");
        if (words[end] === ';') return { op: 'exec', argv };
        if (argv[argv.length - 1] !== '{}' || argv.length === 1) throw new FindUsageError("`-exec … +' needs `{}' right before the `+'");
        if (argv.slice(0, -1).some((w) => w.includes('{}'))) throw new FindUsageError('only one instance of {} is supported with -exec ... +');
        return { op: 'execBatch', argv: argv.slice(0, -1), paths: [] };
      }
      default:
        throw new FindUsageError(`unknown predicate \`${word}'`);
    }
  };

  const unary = async (): Promise<Expr> => {
    const word = words[pos];
    if (word === undefined) throw new FindUsageError('expected an expression');
    if (word === '!' || word === '-not') {
      pos++;
      return { op: 'not', expr: await unary() };
    }
    if (word === '(') {
      pos++;
      const expr = await or();
      if (words[pos] !== ')') throw new FindUsageError("missing `)'");
      pos++;
      return expr;
    }
    if (word === ')') throw new FindUsageError("invalid expression: `)' without `('");
    return await primary();
  };

  const and = async (): Promise<Expr> => {
    let left = await unary();
    while (pos < words.length && isExpressionWord(words[pos]) && words[pos] !== ')' && words[pos] !== '-o' && words[pos] !== '-or') {
      if (words[pos] === '-a' || words[pos] === '-and') pos++;
      left = { op: 'and', left, right: await unary() };
    }
    return left;
  };

  const or = async (): Promise<Expr> => {
    let left = await and();
    while (words[pos] === '-o' || words[pos] === '-or') {
      pos++;
      left = { op: 'or', left, right: await and() };
    }
    return left;
  };

  if (words.length === 0) return { expr: { op: 'print' }, maxdepth, mindepth, depthFirst, trailing: [] };

  const expr = await or();
  // Starting points may follow the expression too, as a tool call puts its positionals last.
  const trailing = words.slice(pos);
  if (trailing.some(isExpressionWord)) throw new FindUsageError(`paths must precede expression: \`${trailing[0]}'`);
  return { expr: hasAction(expr) ? expr : { op: 'and', left: expr, right: { op: 'print' } }, maxdepth, mindepth, depthFirst, trailing };
};

/** The words before the expression, and the expression from its first word on. */
const splitStartingPoints = (args: string[]): [string[], string[]] => {
  const at = args.findIndex(isExpressionWord);
  return at === -1 ? [args, []] : [args.slice(0, at), args.slice(at)];
};

/** A starting point as printed: as given, without trailing slashes, so children join with one. */
const displayRoot = (path: string): string => path === '/' ? path : path.replace(/\/+$/, '') || '/';

const childPath = (parent: string, name: string): string => parent.endsWith('/') ? `${parent}${name}` : `${parent}/${name}`;

const baseName = (path: string): string => path === '/' ? '/' : path.slice(path.lastIndexOf('/') + 1);

/** `%h`: the path's leading directories, `.` when it has none. */
const leadingDirs = (path: string): string => {
  const at = path.lastIndexOf('/');
  if (at === -1) return '.';
  return at === 0 ? '/' : path.slice(0, at);
};

export const find = async (cmd: Command): CmdReturn => {
  const [leading, words] = splitStartingPoints(longToGnu(cmd.args));

  let ownersLoaded: Promise<Owners> | undefined;
  const owners = () => ownersLoaded ??= loadOwners(cmd);

  let parsed: Parsed;
  try {
    parsed = await parseExpression(cmd, words, owners);
  } catch (err) {
    if (!(err instanceof FindUsageError)) throw err;
    await cmd.writeError(`find: ${err.message}\n`);
    return 1;
  }
  const { expr, maxdepth, mindepth, depthFirst, trailing } = parsed;
  const startingPoints = [...leading, ...trailing];
  const lastLevelTypes = requiredTypes(expr);
  const json = cmd.json && !some(expr, (e) => e.op === 'printf' || e.op === 'print0' || e.op === 'exec' || e.op === 'execBatch');

  let status = 0;
  let quit = false;
  cmd.onInterrupt(() => {
    quit = true;
  });

  const results: FindEntry[] = [];

  const print = async (c: Candidate): Promise<void> => {
    if (json) results.push({ path: c.path, type: c.node.type, name: c.name, childCount: c.childCount });
    else await cmd.writeLn(c.path);
  };

  const directive = async (c: Candidate, d: string): Promise<string> => {
    const props = c.node.props;
    switch (d[0]) {
      case 'p':
        return c.path;
      case 'f':
        return c.name;
      case 'h':
        return leadingDirs(c.path);
      case 'P':
        return c.path === c.start ? '' : c.path.slice(c.start.length + (c.start.endsWith('/') ? 0 : 1));
      case 'd':
        return `${c.depth}`;
      case 's':
        return `${fileSize(c.node)}`;
      case 'y':
        return LETTER_OF_TYPE[c.node.type] ?? c.node.type;
      case 'm':
        return (props.mode & 0o7777).toString(8);
      case 'u':
        return (await owners()).users.get(props.uid) ?? `${props.uid}`;
      case 'g':
        return (await owners()).groups.get(props.gid) ?? `${props.gid}`;
      case 'U':
        return `${props.uid}`;
      case 'G':
        return `${props.gid}`;
      case 't':
        return ctime(props.modtime.timestamp);
      case 'c':
        return ctime(props.changetime.timestamp);
      case 'T':
        return timeField(props.modtime.timestamp, d[1]);
      case 'C':
        return timeField(props.changetime.timestamp, d[1]);
      default: // 'B'
        return timeField(props.birthtime.timestamp, d[1]);
    }
  };

  const runBatch = async (e: Expr & { op: 'execBatch' }): Promise<void> => {
    const paths = e.paths.splice(0);
    if (paths.length === 0) return;
    if (await cmd.executeInline([...e.argv, ...paths].map(shellQuote).join(' ')) !== 0) status = 1;
  };

  const remove = async (c: Candidate): Promise<boolean> => {
    // The starting point `.` is the caller's own directory: GNU leaves it in place, and so does this.
    if (c.path === '.') return true;
    try {
      if (await cmd.sys.vfs.childCount(cmd.access, c.vfsPath, { readlink: true, all: true }) > 0) throw new Error('Directory not empty');
      await cmd.sys.vfs.unlink(cmd.access, c.vfsPath, dirname(c.vfsPath), { readlink: true });
      return true;
    } catch (err) {
      await cmd.writeError(`find: cannot delete '${c.path}': ${err instanceof Error ? err.message : String(err)}\n`);
      status = 1;
      return false;
    }
  };

  const evaluate = async (e: Expr, c: Candidate, control: Control): Promise<boolean> => {
    switch (e.op) {
      case 'and':
        return await evaluate(e.left, c, control) && !control.quit && await evaluate(e.right, c, control);
      case 'or':
        return await evaluate(e.left, c, control) || (!control.quit && await evaluate(e.right, c, control));
      case 'not':
        return !await evaluate(e.expr, c, control);
      case 'test':
        return e.test(c);
      case 'true':
        return true;
      case 'print':
        await print(c);
        return true;
      case 'print0':
        await cmd.write(`${c.path}\0`);
        return true;
      case 'printf': {
        let out = '';
        for (const piece of e.format) out += typeof piece === 'string' ? piece : applyWidth(await directive(c, piece.directive), piece.spec);
        await cmd.write(out);
        return true;
      }
      case 'exec':
        return await cmd.executeInline(e.argv.map((word) => shellQuote(word.replaceAll('{}', c.path))).join(' ')) === 0;
      case 'execBatch':
        e.paths.push(c.path);
        if (e.paths.length >= BATCH_SIZE) await runBatch(e);
        return true;
      case 'delete':
        return await remove(c);
      case 'prune':
        control.prune = true;
        return true;
      case 'quit':
        control.quit = true;
        return true;
    }
  };

  const batches: (Expr & { op: 'execBatch' })[] = [];
  const collectBatches = (e: Expr): void => {
    if (e.op === 'execBatch') batches.push(e);
    else if (e.op === 'and' || e.op === 'or') {
      collectBatches(e.left);
      collectBatches(e.right);
    } else if (e.op === 'not') collectBatches(e.expr);
  };
  collectBatches(expr);

  const visit = async (c: Candidate): Promise<void> => {
    if (quit) return;
    const control: Control = { prune: false, quit: false };
    const evaluateHere = async (): Promise<void> => {
      if (c.depth >= mindepth) await evaluate(expr, c, control);
      if (control.quit) quit = true;
    };
    if (!depthFirst) {
      await evaluateHere();
      if (quit) return;
    }
    // Depth first, as `-depth` and `-delete` ask, the directory comes after its children and `-prune` has nothing to stop.
    if ((depthFirst || !control.prune) && c.childCount > 0 && c.depth < maxdepth) {
      // Children at the last level are not descended into, so the store lists only the types that can match.
      const types = lastLevelTypes && c.depth + 1 === maxdepth ? lastLevelTypes : undefined;
      try {
        const entries = await cmd.sys.vfs.children(cmd.access, c.vfsPath, types ? { types } : undefined);
        for (const entry of entries) {
          if (quit) return;
          await visit({
            path: childPath(c.path, entry.name),
            start: c.start,
            vfsPath: childPath(c.vfsPath, entry.name),
            name: entry.name,
            node: entry.node,
            childCount: entry.childCount,
            depth: c.depth + 1,
          });
        }
      } catch (err) {
        await cmd.writeError(`find: '${c.path}': ${err instanceof Error ? err.message : String(err)}\n`);
        status = 1;
      }
    }
    if (depthFirst && !quit) await evaluateHere();
  };

  for (const start of startingPoints.length > 0 ? startingPoints : ['.']) {
    if (quit) break;
    const vfsPath = resolve(cmd.cwd, start);
    let node: Node;
    let childCount: number;
    try {
      node = await cmd.sys.vfs.get(cmd.access, vfsPath);
      childCount = await cmd.sys.vfs.childCount(cmd.access, vfsPath);
    } catch {
      await cmd.writeError(`find: '${start}': No such file or directory\n`);
      status = 1;
      continue;
    }
    const path = displayRoot(start);
    await visit({ path, start: path, vfsPath, name: baseName(path), node, childCount, depth: 0 });
  }

  // `-quit` still runs what `-exec … +` has gathered; an interrupt does not.
  if (!cmd.interrupted) {
    for (const batch of batches) await runBatch(batch);
  }

  if (json) {
    await cmd.writeJSON(results satisfies FindEntry[]);
  }

  return status;
};

find.spec = {
  name: 'find',
  effect: 'read' as const,
  description: 'Search for nodes under a path, as GNU find does: starting points, then an expression of tests ' +
    '(-name -iname -path -ipath GLOB, -regex -iregex RE on the whole path, -type f|d|l|<node type>, -empty, ' +
    '-size [+-]N[cwbkMG], -user -group NAME, -uid -gid N, -newer PATH, -mmin and -mtime [+-]N), ' +
    'operators (! -not -a -o and parentheses), options (-maxdepth -mindepth N, -depth) and actions ' +
    "(-print -print0 -printf FORMAT -prune -quit -delete, -exec CMD {} ';' and -exec CMD {} +); " +
    '-printf knows %p %f %h %P %d %s %y %m %u %g %U %G %t %c and %Tk %Ck %Bk for k in @YymdHMSFTDab+; ' +
    'the flags below are the same tests',
  args: [
    {
      name: 'path',
      type: 'path' as const,
      description: 'starting point, printed itself at depth 0; several may be given (default: .)',
    },
  ],
  flags: [
    { name: 'name', type: 'string' as const, description: 'match the name by glob pattern (-name)' },
    { name: 'iname', type: 'string' as const, description: 'match the name by glob pattern, ignoring case (-iname)' },
    { name: 'type', type: 'string' as const, description: 'node type: f, d, l or one such as person; several comma-separated (-type)' },
    { name: 'maxdepth', type: 'string' as const, description: 'descend at most this many levels: 0 is the starting point alone (-maxdepth)' },
    { name: 'mindepth', type: 'string' as const, description: 'match nothing shallower than this level: 1 leaves out the starting point (-mindepth)' },
  ],
  words: [
    { word: '-delete', writes: true },
    { word: '-exec', runs: [';', '+'] },
  ],
  examples: [
    "find /archive/albums/Exempelalbum_2019 -name '*.jpg' -type f",
    'find /archive/people -mindepth 1 -maxdepth 2 -type person',
    "find /home/anna/staging -name '.tmp*' -prune -o -type f -mmin -60 -print",
    "find /home/anna/staging -type f -size +10M -printf '%s %p\\n'",
    "find /home/anna/staging -name '*.tmp' -exec rm {} +",
  ],
  returns: 'every path -print selects; in JSON each with its type, name and number of children. ' +
    'With -printf, -print0 or -exec the output is text.',
};
