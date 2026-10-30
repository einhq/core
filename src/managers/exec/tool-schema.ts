/**
 * A command's spec, as a tool schema a model can call.
 *
 * Every command carries a `CmdSpec` with a description, typed arguments and per-flag help. This
 * turns it into what a tool-calling model expects, so a command's spec is its tool description.
 *
 * A generated schema names the command, says what it is for, and declares every argument and
 * flag with its type. When to reach for one command rather than another is policy, not schema.
 * `examples` and `returns` are folded into the description rather than into a field no chat
 * template renders.
 *
 * Flag types are load-bearing. `type: 'bool'` is a switch and becomes a boolean; anything else
 * takes a value. An omitted type cannot be told apart from either, which is why the spec test
 * requires one on every flag of a command that is offered as a tool.
 */

import type { CmdArgDef, CmdFlagDef, CmdSpec } from './spec.ts';

export type ToolParameterSchema = {
  type: 'string' | 'number' | 'boolean' | 'array';
  description: string;
  items?: { type: 'string' | 'number' };
};

export type ToolSchema = {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, ToolParameterSchema>;
    required: string[];
  };
};

/** How a completion type reads as a JSON Schema type. Paths, users and groups are strings. */
const jsonType = (type: string | undefined): ToolParameterSchema['type'] => {
  if (type === 'bool') return 'boolean';
  if (type === 'number') return 'number';
  return 'string';
};

/** A positional argument. `variadic` means "and everything after this one", so it is a list. */
const fromArg = (arg: CmdArgDef): ToolParameterSchema =>
  arg.variadic ? { type: 'array', description: `${arg.description} (one or more)`, items: { type: 'string' } } : { type: jsonType(arg.type), description: arg.description };

/**
 * A flag. A repeatable one is a list, one entry per value, which `toolCallToCommandLine` repeats:
 * offered as a string, "pictures of me and my father" could name only one of them.
 */
const fromFlag = (flag: CmdFlagDef): ToolParameterSchema => {
  if (flag.repeatable && flag.type !== 'bool') {
    const items = jsonType(flag.type) === 'number' ? 'number' : 'string';
    return { type: 'array', description: `${flag.description} — a list, one entry each`, items: { type: items } };
  }
  return { type: jsonType(flag.type), description: flag.type === 'bool' ? `${flag.description} (on or off)` : flag.description };
};

/**
 * Single-letter aliases are dropped when a long flag says the same thing.
 *
 * A command that declares `-l` and `--limit` with identical help offers the model only `limit`:
 * offered both, a model picks either, or both. The long name is the one worth spending tokens on.
 */
const withoutAliases = (flags: CmdFlagDef[]): CmdFlagDef[] => {
  const byDescription = new Map<string, CmdFlagDef>();
  for (const flag of flags) {
    const seen = byDescription.get(flag.description);
    if (!seen) byDescription.set(flag.description, flag);
    else if (flag.name.length > seen.name.length) byDescription.set(flag.description, flag);
  }
  return [...byDescription.values()];
};

/** The description a model reads: what it does, what comes back, and what a call looks like. */
export const toolDescription = (spec: CmdSpec): string =>
  [
    spec.description ?? spec.name,
    spec.returns ? `Returns: ${spec.returns}` : undefined,
    spec.examples?.length ? `Examples:\n${spec.examples.map((line) => `  ${line}`).join('\n')}` : undefined,
  ].filter(Boolean).join('\n');

/**
 * One command as one tool.
 *
 * A positional argument keeps its own name, so `search`'s query is `query` rather than a
 * positional slot a model has to guess the shape of.
 */
export const toolSchema = (spec: CmdSpec): ToolSchema => {
  const properties: Record<string, ToolParameterSchema> = {};
  const required: string[] = [];
  for (const arg of spec.args ?? []) {
    properties[arg.name] = fromArg(arg);
    if (!arg.optional) required.push(arg.name);
  }
  for (const flag of withoutAliases(spec.flags ?? [])) {
    // A flag never shadows a positional of the same name: the positional is the call's subject.
    if (!properties[flag.name]) properties[flag.name] = fromFlag(flag);
  }
  return { name: spec.name, description: toolDescription(spec), parameters: { type: 'object', properties, required } };
};

/** The shell line a tool call becomes: what the model asked for, as the archive would run it. */
export const toolCallToCommandLine = (spec: CmdSpec, args: Record<string, unknown>): string => {
  const quote = (value: string) => /^[\w@%+=:,./-]+$/.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
  const positional = new Set((spec.args ?? []).map((arg) => arg.name));
  const switches = new Set((spec.flags ?? []).filter((flag) => flag.type === 'bool').map((flag) => flag.name));
  const parts = [spec.name];
  const trailing: string[] = [];
  for (const [name, value] of Object.entries(args)) {
    if (value === undefined || value === null || value === '') continue;
    if (positional.has(name)) {
      for (const item of Array.isArray(value) ? value : [value]) trailing.push(quote(String(item)));
      continue;
    }
    const dash = name.length === 1 ? '-' : '--';
    // A switch is on or off whatever form the model wrote it in (`"albums": "True"`): passed
    // through, the string would be a stray word on the line. The spec says which flags are
    // switches, so it decides.
    const on = value === true || (switches.has(name) && /^(true|yes|1|on)$/i.test(String(value)));
    const off = value === false || (switches.has(name) && /^(false|no|0|off)$/i.test(String(value)));
    if (on) parts.push(`${dash}${name}`);
    else if (off) continue;
    // A repeatable flag is repeated, which is how every filter in `search` takes more than one.
    // A long flag always takes its value with `=`: the shell reads a word starting with a dash as
    // another flag, and a box west of Greenwich or south of the equator starts with one. A short
    // flag keeps the space form, which is the
    // only one some parsers accept for it, unless its value starts with a dash too.
    else {
      for (const item of Array.isArray(value) ? value : [value]) {
        const text = String(item);
        if (dash === '--' || text.startsWith('-')) parts.push(`${dash}${name}=${quote(text)}`);
        else parts.push(`${dash}${name}`, quote(text));
      }
    }
  }
  return [...parts, ...trailing].join(' ');
};
