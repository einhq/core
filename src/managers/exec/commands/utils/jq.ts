import { collectUnknownFlags, parseArgs, reportUnknownFlags } from '../../../../lib/args/mod.ts';
import { highlighter } from '../../../shell/terminal/mod.ts';
import type { Command } from '../../command.ts';
import { operands } from '../../input.ts';
import { signalExitCode } from '../../signal.ts';
import type { CmdReturn } from '../../types.ts';

/** A subset of jq: field access, iteration, pipes, alternatives and a few builtins (see applyFilter). */
export const jq = async (cmd: Command): CmdReturn => {
  // An undeclared flag is refused rather than ignored. Real-jq spellings this subset does not
  // implement (`-n`, `--arg`, `--argjson`, `--slurp`) are the expected mistake, and `parseArgs`
  // reads the argument after an unknown flag as its value: `jq -n --arg path <path> '<filter>'`
  // would take the path as the filter and block on a stdin that, in the API shell, never ends.
  const unknown: string[] = [];
  const flags = parseArgs(cmd.args, {
    alias: {
      r: 'raw-output',
      e: 'exit-status',
      S: 'sort-keys',
    },
    boolean: ['r', 'e', 'c', 'C', 'M', 'S'],
    unknown: collectUnknownFlags(unknown),
  });

  if (await reportUnknownFlags(cmd, unknown)) {
    return 1;
  }

  // Without a filter, like jq 1.7, the identity: `jq` alone pretty-prints its input.
  const filter = (flags._[0] as string | undefined) || '.';

  // Colored on a terminal, like jq; -C colors anyway and -M never.
  const highlight = highlighter(flags.M || !(flags.C || cmd.tty));
  let outputs = 0;
  let last: unknown;

  // Each FILE holds a stream of JSON texts (one, or JSON Lines), which the filter runs on in turn.
  const inputs = operands(cmd, flags._.slice(1), { error: (file, why) => `jq: error: could not open ${file}: ${why}` });
  for await (const input of inputs) {
    const text = await input.text();
    if (cmd.interrupted) break;

    for (let start = skipWhitespace(text, 0); start < text.length; start = skipWhitespace(text, start)) {
      const end = jsonTextEnd(text, start);
      let data: unknown;
      try {
        data = JSON.parse(text.slice(start, end));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const line = text.slice(0, start).split('\n').length;
        await cmd.writeError(`jq: parse error: ${message} in the JSON text at line ${line}\n`);
        return 5; // jq uses exit code 5 for parse errors
      }
      start = end;

      let results: unknown[];
      try {
        results = runFilter(data, filter);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await cmd.writeError(`jq: ${message}\n`);
        return 1;
      }

      for (const result of results) {
        if (typeof result === 'string' && flags['raw-output']) {
          await cmd.writeLn(result);
        } else {
          const outputData = flags.S ? sortKeys(result) : result;
          await cmd.writeLn(highlight(JSON.stringify(outputData, null, flags.c ? undefined : 2), 'json'));
        }
      }
      outputs += results.length;
      if (results.length > 0) last = results.at(-1);
      if (cmd.interrupted) break;
    }
  }

  if (cmd.interrupted) return signalExitCode(cmd.signal ?? 'SIGINT');
  if (inputs.failed) return 2;

  // -e: exit 1 when the last output is false or null, or there is none (matching jq), else 0.
  if (flags['exit-status'] && (outputs === 0 || last === null || last === false)) {
    return 1;
  }

  return 0;
};

function skipWhitespace(text: string, i: number): number {
  while (i < text.length && /\s/.test(text[i])) i++;
  return i;
}

/**
 * Where the JSON text starting at `start` ends: past the bracket closing an object or array, the
 * quote closing a string, or before the whitespace or next text ending a number or literal. It
 * finds the extent only; JSON.parse on that slice reports what is malformed in it.
 */
function jsonTextEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === '\\') i++;
      else if (ch === '"') {
        inString = false;
        if (depth === 0) return i + 1;
      }
    } else if (ch === '"') {
      if (depth === 0 && i > start) return i;
      inString = true;
    } else if (ch === '{' || ch === '[') {
      if (depth === 0 && i > start) return i;
      depth++;
    } else if (ch === '}' || ch === ']') {
      depth--;
      if (depth <= 0) return i + 1;
    } else if (depth === 0 && /\s/.test(ch)) {
      return i;
    }
  }
  return text.length;
}

function sortKeys(obj: unknown): unknown {
  if (Array.isArray(obj)) {
    return obj.map(sortKeys);
  } else if (obj && typeof obj === 'object' && obj.constructor === Object) {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = sortKeys((obj as Record<string, unknown>)[key]);
    }
    return sorted;
  } else {
    return obj;
  }
}

/**
 * The outputs of a filter on one input. Like jq, a filter yields a stream: `.[]` yields one
 * output per element, and each pipe stage runs on every output of the stage before it.
 */
function runFilter(data: unknown, filter: string): unknown[] {
  let inputs = [data];
  for (const stage of splitPipe(filter)) {
    inputs = inputs.flatMap((input) => runAlternatives(input, splitAlternatives(stage)));
  }
  return inputs;
}

/** `a // b`: the outputs of `a` that are neither false nor null, or else those of `b`. */
function runAlternatives(data: unknown, alternatives: string[]): unknown[] {
  if (alternatives.length === 1) {
    return applyFilter(data, alternatives[0]);
  }
  let outputs: unknown[] = [];
  for (const alt of alternatives) {
    outputs = alt === 'empty' ? [] : applyFilter(data, alt);
    const truthy = outputs.filter((v) => v !== null && v !== false);
    if (truthy.length > 0) return truthy;
  }
  return outputs;
}

/** A filter split on its | pipes. */
function splitPipe(filter: string): string[] {
  const parts: string[] = [];
  let current = '';
  let depth = 0;
  for (let i = 0; i < filter.length; i++) {
    const ch = filter[i];
    if (ch === '(' || ch === '[') depth++;
    else if (ch === ')' || ch === ']') depth--;
    else if (ch === '|' && depth === 0 && filter[i + 1] !== '|') {
      // A single |; `//` is the alternative operator, split on separately.
      if (i > 0 && filter[i - 1] === '/') {
        current += ch;
        continue;
      }
      parts.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  parts.push(current.trim());
  return parts.filter((p) => p.length > 0);
}

/** A filter split on its // alternatives. */
function splitAlternatives(filter: string): string[] {
  const parts: string[] = [];
  let current = '';
  for (let i = 0; i < filter.length; i++) {
    if (filter[i] === '/' && filter[i + 1] === '/') {
      parts.push(current.trim());
      i++; // skip second /
      current = '';
    } else {
      current += filter[i];
    }
  }
  parts.push(current.trim());
  return parts;
}

/**
 * The outputs of a jq-style filter without pipes or alternatives. Supports:
 *   . (identity)
 *   .field (object field access)
 *   .field.nested (nested access)
 *   .field? (optional - returns null instead of error)
 *   .[n] (array index)
 *   .[] / .field[] (iterate an array's elements or an object's values; .[]? skips non-iterables)
 *   length, keys, type
 *   map(f) (f applied to each element, collected into an array)
 *   startswith("x") / endswith("x") (string predicates)
 */
function applyFilter(data: unknown, filter: string): unknown[] {
  if (filter === '.') {
    return [data];
  }

  if (filter === 'length') {
    return [getLength(data)];
  }
  if (filter === 'keys') {
    if (data && typeof data === 'object' && !Array.isArray(data)) {
      return [Object.keys(data)];
    }
    if (Array.isArray(data)) {
      return [data.map((_, i) => i)];
    }
    throw new Error(`null has no keys`);
  }
  if (filter === 'type') {
    return [getType(data)];
  }

  const mapMatch = filter.match(/^map\((.*)\)$/s);
  if (mapMatch) {
    return [iterate(data, false).flatMap((element) => runFilter(element, mapMatch[1].trim()))];
  }

  // Builtin string predicates with a quoted argument, e.g. startswith("image/").
  // Like jq, these require string input.
  const fnMatch = filter.match(/^(startswith|endswith)\(\s*"((?:[^"\\]|\\.)*)"\s*\)$/);
  if (fnMatch) {
    const [, fn, rawArg] = fnMatch;
    const arg = rawArg.replace(/\\(.)/g, '$1');
    if (typeof data !== 'string') {
      throw new Error(`${fn}() requires string input`);
    }
    return [fn === 'startswith' ? data.startsWith(arg) : data.endsWith(arg)];
  }

  let outputs = [data];
  for (const segment of parseFilter(filter)) {
    outputs = outputs.flatMap((current) => applySegment(current, segment));
  }
  return outputs;
}

function applySegment(current: unknown, segment: FilterSegment): unknown[] {
  if (segment.type === 'iterate') {
    return iterate(current, segment.optional);
  }

  if (current === null) {
    if (segment.optional) {
      return [null];
    }
    throw new Error(`cannot access ${segment.name} on null`);
  }

  if (segment.type === 'field') {
    if (typeof current !== 'object') {
      if (segment.optional) {
        return [null];
      }
      throw new Error(`cannot index ${typeof current} with string "${segment.name}"`);
    }
    return [(current as Record<string, unknown>)[segment.name] ?? null];
  }

  if (!Array.isArray(current)) {
    if (segment.optional) {
      return [null];
    }
    throw new Error(`cannot index ${typeof current} with number`);
  }
  return [current[segment.index] ?? null];
}

/** An array's elements or an object's values; anything else is an error unless optional. */
function iterate(current: unknown, optional: boolean): unknown[] {
  if (Array.isArray(current)) {
    return current;
  }
  if (current !== null && typeof current === 'object') {
    return Object.values(current);
  }
  if (optional) {
    return [];
  }
  throw new Error(`cannot iterate over ${getType(current)}`);
}

interface FilterSegment {
  type: 'field' | 'index' | 'iterate';
  name: string;
  index: number;
  optional: boolean;
}

function parseFilter(filter: string): FilterSegment[] {
  const segments: FilterSegment[] = [];
  let i = 0;

  if (filter[i] !== '.') {
    throw new Error(`filter must start with '.'`);
  }
  i++;

  while (i < filter.length) {
    // .[n]
    if (filter[i] === '[') {
      const endBracket = filter.indexOf(']', i);
      if (endBracket === -1) {
        throw new Error('unclosed bracket in filter');
      }
      const indexStr = filter.slice(i + 1, endBracket).trim();
      let optional = false;
      let nextI = endBracket + 1;
      if (filter[nextI] === '?') {
        optional = true;
        nextI++;
      }

      if (indexStr === '') {
        segments.push({ type: 'iterate', name: '', index: 0, optional });
        i = nextI;
        continue;
      }

      const index = parseInt(indexStr, 10);
      if (isNaN(index)) {
        throw new Error(`invalid array index: ${indexStr}`);
      }

      segments.push({ type: 'index', name: '', index, optional });
      i = nextI;
      continue;
    }

    // .field or .field?
    if (filter[i] === '.') {
      i++;
    }

    let name = '';
    while (i < filter.length && /[a-zA-Z0-9_-]/.test(filter[i])) {
      name += filter[i];
      i++;
    }

    if (name.length === 0) {
      throw new Error(`expected field name at position ${i}`);
    }

    let optional = false;
    if (filter[i] === '?') {
      optional = true;
      i++;
    }

    segments.push({ type: 'field', name, index: 0, optional });
  }

  return segments;
}

function getLength(data: unknown): number {
  if (data === null) return 0;
  if (typeof data === 'string') return data.length;
  if (Array.isArray(data)) return data.length;
  if (typeof data === 'object') return Object.keys(data).length;
  throw new Error(`${typeof data} has no length`);
}

function getType(data: unknown): string {
  if (data === null) return 'null';
  if (Array.isArray(data)) return 'array';
  if (typeof data === 'object') return 'object';
  if (typeof data === 'number') return 'number';
  if (typeof data === 'string') return 'string';
  if (typeof data === 'boolean') return 'boolean';
  return 'null';
}

jq.spec = {
  name: 'jq',
  effect: 'read' as const,
  description: 'Lightweight JSON processor',
  args: [
    {
      name: 'filter',
      type: 'string' as const,
      description: 'jq filter expression (e.g., .field, .field.nested, .[] | .name, startswith("x")); . if omitted',
    },
    {
      name: 'FILE',
      type: 'path' as const,
      description: 'files of JSON texts (one, or JSON Lines), each text filtered in turn (stdin if omitted, or for -)',
      variadic: true,
    },
  ],
  flags: [
    { name: 'r', type: 'bool' as const, description: 'output raw strings, not JSON texts' },
    { name: 'e', type: 'bool' as const, description: 'exit with status 1 if output is null or false' },
    { name: 'c', type: 'bool' as const, description: 'compact instead of pretty-printed output' },
    { name: 'C', type: 'bool' as const, description: 'colorize JSON output even when not on a terminal' },
    { name: 'M', type: 'bool' as const, description: 'do not colorize JSON output' },
    { name: 'S', type: 'bool' as const, description: 'Output the fields of each object with the keys in sorted order.' },
  ],
};
