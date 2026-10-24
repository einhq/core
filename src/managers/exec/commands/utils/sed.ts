/**
 * sed: stream editor for filtering and transforming text in pipes.
 *
 * Supported: s/re/repl/flags (g, i/I, p, Nth, alt delimiters, & and \1 backrefs),
 * p (print) and d (delete), with addressing (line N, $, /regex/, ranges, and !
 * negation), -n (suppress auto-print), -e SCRIPT (repeatable), and ; / newline
 * separated commands. FILE args are read from the VFS; stdin is used if none, and for `-`.
 *
 * Patterns are compiled as JavaScript RegExp (ERE-like, same as `grep`), which is a
 * deliberate deviation from GNU sed's default BRE: (, ), +, ?, | are special without
 * backslashes. -E / -r are accepted as no-ops.
 *
 * Not supported: a/i/c (append/insert/change), y transliterate (use `tr`), q, -i
 * in-place edit, w/r file I/O, labels/branches, hold space, and BRE emulation.
 */

import { parseArgs } from '../../../../lib/args/mod.ts';
import type { Command } from '../../command.ts';
import { operands } from '../../input.ts';
import { signalExitCode } from '../../signal.ts';
import { CmdReturn } from '../../types.ts';

type Address =
  | { kind: 'line'; n: number }
  | { kind: 'last' }
  | { kind: 'regex'; re: RegExp };

type AddrSpec =
  | { type: 'none' }
  | { type: 'one'; addr: Address }
  | { type: 'range'; start: Address; end: Address };

type ReplToken =
  | { t: 'lit'; s: string }
  | { t: 'group'; n: number }
  | { t: 'whole' };

type SubOp = {
  cmd: 's';
  re: RegExp; // always carries the 'g' flag; iteration is controlled manually
  replacement: ReplToken[];
  global: boolean;
  nth: number;
  print: boolean;
};

type Op = SubOp | { cmd: 'p' } | { cmd: 'd' };

type ScriptCommand = {
  addr: AddrSpec;
  negate: boolean;
  op: Op;
  inRange?: boolean;
};

/** Parse a full sed script into an ordered list of commands. Throws on malformed input. */
function parseScript(src: string): ScriptCommand[] {
  const cmds: ScriptCommand[] = [];
  const n = src.length;
  let i = 0;

  const isSep = (c: string) => c === ';' || c === '\n' || c === '\r' || c === ' ' || c === '\t';
  const skipSep = () => {
    while (i < n && isSep(src[i])) i++;
  };
  const skipSpace = () => {
    while (i < n && (src[i] === ' ' || src[i] === '\t')) i++;
  };

  const parseAddress = (): Address | null => {
    const c = src[i];
    if (c === '$') {
      i++;
      return { kind: 'last' };
    }
    if (c >= '0' && c <= '9') {
      let num = '';
      while (i < n && src[i] >= '0' && src[i] <= '9') num += src[i++];
      return { kind: 'line', n: parseInt(num, 10) };
    }
    if (c === '/') {
      i++;
      let pat = '';
      while (i < n && src[i] !== '/') {
        if (src[i] === '\\' && i + 1 < n) {
          if (src[i + 1] === '/') pat += '/';
          else pat += src[i] + src[i + 1];
          i += 2;
          continue;
        }
        pat += src[i++];
      }
      if (i >= n) throw new Error('unterminated address regex');
      i++;
      try {
        return { kind: 'regex', re: new RegExp(pat) };
      } catch {
        throw new Error(`invalid regex: ${pat}`);
      }
    }
    return null;
  };

  const parseSubstitute = (): SubOp => {
    const delim = src[i];
    if (delim === undefined || delim === '\\' || delim === '\n') {
      throw new Error("bad delimiter for 's' command");
    }
    i++;

    let patSrc = '';
    while (i < n && src[i] !== delim) {
      if (src[i] === '\\' && i + 1 < n) {
        if (src[i + 1] === delim) patSrc += delim;
        else patSrc += src[i] + src[i + 1];
        i += 2;
        continue;
      }
      patSrc += src[i++];
    }
    if (i >= n) throw new Error("unterminated 's' command");
    i++;

    const replacement: ReplToken[] = [];
    let lit = '';
    const flush = () => {
      if (lit) {
        replacement.push({ t: 'lit', s: lit });
        lit = '';
      }
    };
    while (i < n && src[i] !== delim) {
      const ch = src[i];
      if (ch === '\\' && i + 1 < n) {
        const nx = src[i + 1];
        if (nx === delim) lit += delim;
        else if (nx >= '1' && nx <= '9') {
          flush();
          replacement.push({ t: 'group', n: nx.charCodeAt(0) - 48 });
        } else if (nx === 'n') lit += '\n';
        else if (nx === 't') lit += '\t';
        else if (nx === 'r') lit += '\r';
        else lit += nx; // \&, \\, and any other escape become the literal char
        i += 2;
        continue;
      }
      if (ch === '&') {
        flush();
        replacement.push({ t: 'whole' });
        i++;
        continue;
      }
      lit += ch;
      i++;
    }
    if (i >= n) throw new Error("unterminated 's' command");
    flush();
    i++;

    let global = false;
    let ignoreCase = false;
    let multiline = false;
    let print = false;
    let nth = 0;
    loop: while (i < n) {
      const f = src[i];
      switch (f) {
        case 'g':
          global = true;
          i++;
          break;
        case 'p':
          print = true;
          i++;
          break;
        case 'i':
        case 'I':
          ignoreCase = true;
          i++;
          break;
        case 'm':
        case 'M':
          multiline = true;
          i++;
          break;
        default:
          if (f >= '0' && f <= '9') {
            let num = '';
            while (i < n && src[i] >= '0' && src[i] <= '9') num += src[i++];
            nth = parseInt(num, 10);
          } else {
            break loop;
          }
      }
    }
    if (nth === 0) nth = 1;

    let reFlags = 'g';
    if (ignoreCase) reFlags += 'i';
    if (multiline) reFlags += 'm';
    let re: RegExp;
    try {
      re = new RegExp(patSrc, reFlags);
    } catch {
      throw new Error(`invalid regex: ${patSrc}`);
    }
    return { cmd: 's', re, replacement, global, nth, print };
  };

  while (true) {
    skipSep();
    if (i >= n) break;

    const addr1 = parseAddress();
    let addr: AddrSpec;
    if (addr1 === null) {
      addr = { type: 'none' };
    } else if (src[i] === ',') {
      i++;
      const addr2 = parseAddress();
      if (addr2 === null) throw new Error("expected address after ','");
      addr = { type: 'range', start: addr1, end: addr2 };
    } else {
      addr = { type: 'one', addr: addr1 };
    }

    skipSpace();
    let negate = false;
    while (src[i] === '!') {
      negate = !negate;
      i++;
      skipSpace();
    }

    const cmdChar = src[i];
    if (cmdChar === undefined) throw new Error('missing command');
    i++;

    if (cmdChar === 's') cmds.push({ addr, negate, op: parseSubstitute() });
    else if (cmdChar === 'p') cmds.push({ addr, negate, op: { cmd: 'p' } });
    else if (cmdChar === 'd') cmds.push({ addr, negate, op: { cmd: 'd' } });
    else throw new Error(`unknown command: '${cmdChar}'`);
  }

  return cmds;
}

function buildReplacement(tokens: ReplToken[], m: RegExpExecArray): string {
  let out = '';
  for (const tok of tokens) {
    if (tok.t === 'lit') out += tok.s;
    else if (tok.t === 'whole') out += m[0];
    else out += m[tok.n] ?? '';
  }
  return out;
}

/** Apply a substitution to a single line, honoring global / Nth semantics. */
function applySub(op: SubOp, line: string): { text: string; changed: boolean } {
  const re = op.re;
  re.lastIndex = 0;
  let result = '';
  let last = 0;
  let count = 0;
  let changed = false;
  let m: RegExpExecArray | null;

  while ((m = re.exec(line)) !== null) {
    count++;
    const replaceThis = op.global ? count >= op.nth : count === op.nth;
    if (replaceThis) {
      result += line.slice(last, m.index);
      result += buildReplacement(op.replacement, m);
      last = m.index + m[0].length;
      changed = true;
    }
    if (m[0].length === 0) re.lastIndex++; // guard against zero-width match loops
    if (!op.global && count >= op.nth) break;
  }

  result += line.slice(last);
  return { text: result, changed };
}

function matchAddress(a: Address, lineNo: number, line: string, lastLineNo: number): boolean {
  switch (a.kind) {
    case 'line':
      return lineNo === a.n;
    case 'last':
      return lineNo === lastLineNo;
    case 'regex':
      return a.re.test(line);
  }
}

/** Decide whether a command applies to the current line, updating range state. */
function isActive(c: ScriptCommand, lineNo: number, line: string, lastLineNo: number): boolean {
  let active: boolean;
  const spec = c.addr;
  if (spec.type === 'none') {
    active = true;
  } else if (spec.type === 'one') {
    active = matchAddress(spec.addr, lineNo, line, lastLineNo);
  } else if (!c.inRange) {
    if (matchAddress(spec.start, lineNo, line, lastLineNo)) {
      c.inRange = true;
      active = true;
      // an end line number at or before the start collapses the range to one line
      if (spec.end.kind === 'line' && spec.end.n <= lineNo) c.inRange = false;
    } else {
      active = false;
    }
  } else {
    active = true;
    if (matchAddress(spec.end, lineNo, line, lastLineNo)) c.inRange = false;
  }
  return c.negate ? !active : active;
}

export const sed = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {
    boolean: ['n', 'E', 'r'],
    string: ['e'],
    collect: ['e'],
  });

  const eScripts = flags.e as string[];
  let scriptText: string;
  let filePaths: string[];
  if (eScripts.length > 0) {
    scriptText = eScripts.join('\n');
    filePaths = flags._.map(String);
  } else {
    if (flags._.length === 0) {
      await cmd.writeError('sed: no script specified\n');
      return 2;
    }
    scriptText = String(flags._[0]);
    filePaths = flags._.slice(1).map(String);
  }

  let commands: ScriptCommand[];
  try {
    commands = parseScript(scriptText);
  } catch (error) {
    await cmd.writeError(`sed: ${(error as Error).message}\n`);
    return 2;
  }

  // The FILEs are one stream of lines; each file's last line ends with it, newline or not.
  const inputs = operands(cmd, filePaths, { stopAtError: true });
  const lines: string[] = [];
  for await (const input of inputs) {
    for await (const line of input.lines()) lines.push(line);
  }
  if (cmd.interrupted) return signalExitCode(cmd.signal ?? 'SIGINT');
  if (inputs.failed) return 2;
  const lastLineNo = lines.length;

  const suppress = flags.n;
  const output: string[] = [];

  for (let idx = 0; idx < lines.length; idx++) {
    const lineNo = idx + 1;
    let pattern = lines[idx];
    let deleted = false;

    for (const c of commands) {
      if (!isActive(c, lineNo, pattern, lastLineNo)) continue;
      const op = c.op;
      if (op.cmd === 'd') {
        deleted = true;
        break;
      } else if (op.cmd === 'p') {
        output.push(pattern);
      } else {
        const { text, changed } = applySub(op, pattern);
        pattern = text;
        if (changed && op.print) output.push(pattern);
      }
    }

    if (!deleted && !suppress) output.push(pattern);
  }

  for (const line of output) {
    await cmd.write(`${line}\n`);
  }

  return 0;
};

sed.spec = {
  name: 'sed',
  effect: 'read' as const,
  json: false,
  description: 'Stream editor for filtering and transforming text',
  args: [
    {
      name: 'SCRIPT',
      type: 'string' as const,
      description: 'sed script (e.g. s/foo/bar/g); omit when using -e',
    },
    {
      name: 'FILE',
      type: 'path' as const,
      description: 'files to process (reads from stdin if omitted)',
      variadic: true,
    },
  ],
  flags: [
    { name: 'n', type: 'bool' as const, description: 'suppress automatic printing of pattern space' },
    { name: 'e', type: 'string' as const, description: 'add the script to the commands to be executed (repeatable)' },
    { name: 'E', type: 'bool' as const, description: 'use extended regular expressions (patterns are JS regex)' },
    { name: 'r', type: 'bool' as const, description: 'alias for -E' },
  ],
};
