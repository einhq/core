/**
 * Whether a shell line changes anything, judged from its parse and the specs of the commands in it.
 *
 * A caller acting for someone — the chat assistant — runs a read at once and shows a write to the
 * user first. The line is a read only when every command in it, in pipes, lists, loops and
 * command substitutions alike, resolves to a spec that is a read with the flags and arguments
 * given, and nothing in it redirects output into a file. Anything the judge cannot vouch for — an
 * unknown command, a command named by a variable, `eval`, a line that does not parse — is a write,
 * because the cost of asking once is a click and the cost of guessing is a change nobody saw.
 *
 * This guards against a caller's mistakes, not against privilege: a line runs as its user either
 * way, with their access.
 */

import { parse } from '@ein/bash-executor';
import type { CmdArgDef, CmdEffect, CmdFlagDef, CmdSpec } from './spec.ts';

export type Judgement = { effect: CmdEffect; reasons: string[] };

/** A command's spec by name, or nothing when there is no such command or it has no spec. */
export type SpecLookup = (name: string) => CmdSpec | undefined | Promise<CmdSpec | undefined>;

/**
 * Shell builtins that change nothing outside the line's own shell, which is thrown away with it.
 * Not `eval`, `source`, `.`, `exec`, `command` or `builtin`: each runs whatever it is given.
 */
const READ_BUILTINS = new Set([
  'echo',
  'printf',
  'pwd',
  'cd',
  'pushd',
  'popd',
  'dirs',
  'test',
  '[',
  'true',
  'false',
  ':',
  'type',
  'declare',
  'typeset',
  'local',
  'export',
  'readonly',
  'let',
  'set',
  'shift',
  'unset',
  'read',
  'mapfile',
  'readarray',
  'getopts',
  'exit',
  'return',
]);

/** Redirections that only read. */
const READ_REDIRECTS = new Set(['<', '<<', '<<-', '<<<']);
/** `>&` and `<&` onto a descriptor (`2>&1`) or closing one (`>&-`) point a stream; onto a name, `>&` writes it. */
const DUPLICATES = new Set(['>&', '<&']);
const DESCRIPTOR = /^(\d+|-)$/;
const NULL_DEVICE = '/dev/null';

const redirectWrites = ({ op, file }: Redirect): boolean =>
  !READ_REDIRECTS.has(op.text) && file.text !== NULL_DEVICE && !(DUPLICATES.has(op.text) && DESCRIPTOR.test(file.text));

type Word = { type: 'Word'; text: string };
type Redirect = { type: 'Redirect'; op: { text: string }; file: { text: string } };
type CommandNode = { type: 'Command'; name?: Word; suffix?: (Word | Redirect)[]; prefix?: unknown[] };

/** The flag a word names, without its dashes or value: `--kind=photo` → `kind`; `-abc` → `a`, `b`, `c`. */
const flagNames = (word: string): string[] => {
  if (word.startsWith('--')) return [word.slice(2).split('=')[0]];
  return [...word.slice(1)];
};

/** Every command answers `--help` or `-h` as its first word with its spec, and does nothing else. */
const asksHelp = (words: string[]): boolean => words[0] === '--help' || words[0] === '-h';

const takesValue = (flag: CmdFlagDef | undefined): boolean => !!flag && flag.type !== undefined && flag.type !== 'bool';

/** One command, as its spec says: the reasons it writes, or none when it only reads. */
const judgeCommand = async (node: CommandNode, specOf: SpecLookup): Promise<string[]> => {
  const reasons: string[] = [];
  const words = (node.suffix ?? []).filter((part): part is Word => part.type === 'Word').map((word) => word.text);
  const name = node.name?.text;
  // A bare assignment, `X=1`, runs nothing.
  if (name === undefined) return reasons;
  if (!name || /[$`]/.test(name)) return [...reasons, 'the command is named by an expansion'];
  if (READ_BUILTINS.has(name)) return reasons;
  if (asksHelp(words)) return reasons;

  let spec = await specOf(name);
  let args = words;
  // A group dispatcher routes to `<group>-<sub>`: that one is judged.
  if (spec?.group) {
    const sub = words.find((word) => !word.startsWith('-'));
    const routed = sub ? await specOf(`${name}-${sub}`) : undefined;
    if (!routed) return [...reasons, `${name} ${sub ?? ''}`.trim() + ' is not a known subcommand'];
    spec = routed;
    args = words.slice(words.indexOf(sub!) + 1);
    if (asksHelp(args)) return reasons;
  }
  if (!spec) return [...reasons, `${name} is not a known command`];
  if (spec.effect === undefined) return [...reasons, `${spec.name} does not say whether it changes anything`];

  const flags = new Map((spec.flags ?? []).map((flag) => [flag.name, flag]));
  // A dry run reports what the command would do and does none of it.
  const dryRun = args.some((word) => word.startsWith('-') && flagNames(word).some((flagName) => flags.get(flagName)?.dryRun));
  if (dryRun) return reasons;
  if (spec.effect === 'write') return [...reasons, `${spec.name} changes something`];

  // An expression's words count wherever they stand, and the command one runs is judged as any other.
  const expressionWords = new Map((spec.words ?? []).map((def) => [def.word, def]));
  if (expressionWords.size > 0) {
    const rest: string[] = [];
    for (let i = 0; i < args.length; i++) {
      const def = expressionWords.get(args[i]);
      if (!def) {
        rest.push(args[i]);
        continue;
      }
      if (def.writes) reasons.push(`${spec.name} ${def.word} changes something`);
      if (!def.runs) continue;
      const end = args.findIndex((word, at) => at > i && def.runs!.includes(word));
      const [inner, ...innerArgs] = args.slice(i + 1, end === -1 ? undefined : end);
      if (inner !== undefined) {
        const suffix = innerArgs.map((text): Word => ({ type: 'Word', text }));
        reasons.push(...await judgeCommand({ type: 'Command', name: { type: 'Word', text: inner }, suffix }, specOf));
      }
      i = end === -1 ? args.length : end;
    }
    args = rest;
  }

  const writingFlags = (spec.flags ?? []).some((flag) => flag.writes);
  const positional: string[] = [];
  // An argument that `runs` a command takes every word from it on: no flag of the call's follows.
  const runsAt = (spec.args ?? []).findIndex((arg) => arg.runs);
  for (let i = 0; i < args.length; i++) {
    const word = args[i];
    if (word === '--') {
      positional.push(...args.slice(i + 1));
      break;
    }
    // A digit is a negative number unless the spec has a flag by that name (`xargs -0`).
    if (!word.startsWith('-') || word === '-' || (/^-\d/.test(word) && !flags.has(word[1]))) {
      if (positional.length === runsAt) {
        positional.push(...args.slice(i));
        break;
      }
      positional.push(word);
      continue;
    }
    const names = flagNames(word);
    for (const flagName of names) {
      const flag = flags.get(flagName);
      if (flag?.writes) reasons.push(`${spec.name} ${word.split('=')[0]} changes something`);
      // A flag the spec does not list may be an alias of one that writes: only a command with no
      // writing flag at all can be trusted with it.
      else if (!flag && writingFlags) reasons.push(`${spec.name} ${word.split('=')[0]} is not in its spec`);
    }
    const last = flags.get(names[names.length - 1]);
    if (takesValue(last) && !word.includes('=') && (word.startsWith('--') || names.length === 1)) i++;
  }
  if (runsAt !== -1 && positional.length > runsAt) {
    const [inner, ...innerArgs] = positional.splice(runsAt);
    const suffix = innerArgs.map((text): Word => ({ type: 'Word', text }));
    reasons.push(...await judgeCommand({ type: 'Command', name: { type: 'Word', text: inner }, suffix }, specOf));
  }
  (spec.args ?? []).forEach((arg: CmdArgDef, index) => {
    if (positional.length <= index || !arg.writes) return;
    if (arg.writes === true) reasons.push(`${spec!.name} with ${arg.name} changes something`);
    else if (arg.writes.includes(positional[index])) reasons.push(`${spec!.name} ${positional[index]} changes something`);
  });
  return reasons;
};

/** Every Command and Redirect in a parse, wherever it sits: lists, pipes, loops, bodies, substitutions. */
const walk = (value: unknown, visit: (node: { type: string }) => void): void => {
  if (Array.isArray(value)) {
    for (const item of value) walk(item, visit);
    return;
  }
  if (!value || typeof value !== 'object') return;
  const node = value as { type?: unknown };
  if (typeof node.type === 'string') visit(node as { type: string });
  for (const [key, child] of Object.entries(node)) {
    if (key !== 'loc') walk(child, visit);
  }
};

/**
 * A line — or a script of several — as a read or a write, with the reasons it writes.
 *
 * `specOf` gives a command's spec. Nothing is run.
 */
export const judgeLine = async (line: string, specOf: SpecLookup): Promise<Judgement> => {
  let script: unknown;
  try {
    script = parse(line);
  } catch (error) {
    return { effect: 'write', reasons: [`the line does not parse: ${error instanceof Error ? error.message : String(error)}`] };
  }
  const commands: CommandNode[] = [];
  const reasons: string[] = [];
  walk(script, (node) => {
    if (node.type === 'Command') commands.push(node as CommandNode);
    else if (node.type === 'Function') reasons.push('it defines a function');
    else if (node.type === 'Redirect') {
      // A command's, a loop's or a group's alike.
      const redirect = node as Redirect;
      if (redirectWrites(redirect)) reasons.push(`${redirect.op.text} ${redirect.file.text} writes a file`);
    }
  });
  for (const command of commands) reasons.push(...await judgeCommand(command, specOf));
  const unique = [...new Set(reasons)];
  return { effect: unique.length ? 'write' : 'read', reasons: unique };
};

/** The commands a line runs, by name, in order: every simple command, substitutions included. Empty when it does not parse. */
export const commandsIn = async (line: string): Promise<string[]> => {
  let script: unknown;
  try {
    script = parse(line);
  } catch {
    return [];
  }
  const names: string[] = [];
  walk(script, (node) => {
    const name = node.type === 'Command' ? (node as CommandNode).name?.text : undefined;
    if (name) names.push(name);
  });
  return names;
};
