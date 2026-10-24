/**
 * awk: pattern scanning and processing, for the common one-liners and short scripts.
 *
 * Supported: BEGIN and END, patterns (a regex, an expression, `pat1, pat2` ranges) with or
 * without an action; fields ($0, $1 … $NF, assignable, NF assignable) split by FS (a blank —
 * the default — for runs of blanks, one other character literally, "" for every character,
 * longer for a regex); NR, NF, FNR, FS, OFS, ORS, RS (newline, "" for paragraphs, one character,
 * or a regex), FILENAME, SUBSEP, RSTART, RLENGTH, CONVFMT, OFMT, ENVIRON; associative arrays
 * (`a[i,j]`, `in`, `delete`, `for (k in a)`); every operator, with awk's string and number
 * rules; if, while, do, for, break, continue, next, exit; user functions (arrays by reference);
 * print and printf (%d %i %o %x %X %u %c %s %e %E %f %F %g %G, flags, width, precision, `*`);
 * length, substr, index, split, sub, gsub, match, sprintf, tolower, toupper, int, sqrt, exp,
 * log, sin, cos, atan2, rand, srand, close and fflush (no-ops). -F, -v var=value (repeatable)
 * and -f PROGFILE; FILE arguments are read from the VFS, stdin when there are none, and a
 * `var=value` argument among them is assigned before the next file.
 *
 * Regexes are JavaScript RegExp (ERE-like, as in `grep` and `sed`), with the POSIX bracket
 * classes ([:alpha:], [:digit:] …) translated.
 *
 * Not supported: getline, system(), output redirection and pipes (`print > "file"`,
 * `print | "cmd"` — only "/dev/stdout" and "/dev/stderr" are accepted), and gawk extensions
 * beyond `length(array)` and an empty FS.
 */

import type { Command } from '../../command.ts';
import { readOperand } from '../../input.ts';
import { signalExitCode } from '../../signal.ts';
import { CmdReturn } from '../../types.ts';

// ---------------------------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------------------------

/** A string that came from input (a field, -v, split): compared as a number when it looks like one. */
type StrNum = { s: string; n: number; numeric: boolean };
type Value = number | string | StrNum;
type AwkArray = Map<string, Value>;

const NUMERIC = /^[ \t\n]*[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?[ \t\n]*$/;
const NUMBER_PREFIX = /^[ \t\n]*[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/;

const strnum = (s: string): StrNum => {
  const numeric = NUMERIC.test(s);
  return { s, n: numeric ? Number(s) : prefixNumber(s), numeric };
};

/** The uninitialized value: "" as a string, 0 as a number, and compared as a number. */
const UNINIT: StrNum = { s: '', n: 0, numeric: true };

const prefixNumber = (s: string): number => {
  const match = NUMBER_PREFIX.exec(s);
  return match ? Number(match[0]) : 0;
};

const isStrNum = (v: Value): v is StrNum => typeof v === 'object';

const toNum = (v: Value): number => typeof v === 'number' ? v : typeof v === 'string' ? prefixNumber(v) : v.n;

const isNumericValue = (v: Value): boolean => typeof v === 'number' || (isStrNum(v) && v.numeric);

const truthy = (v: Value): boolean => {
  if (typeof v === 'number') return v !== 0;
  if (typeof v === 'string') return v !== '';
  return v.numeric ? v.n !== 0 : v.s !== '';
};

/** A number as awk writes it: an integer plainly, anything else through `fmt` (CONVFMT or OFMT). */
const numberString = (n: number, fmt: string): string => {
  if (Number.isNaN(n)) return n < 0 ? '-nan' : 'nan';
  if (!Number.isFinite(n)) return n < 0 ? '-inf' : 'inf';
  if (Number.isInteger(n) && Math.abs(n) < 1e16) return String(n);
  return sprintf(fmt, [n]);
};

// ---------------------------------------------------------------------------------------------
// printf
// ---------------------------------------------------------------------------------------------

const pad = (text: string, width: number, left: boolean, zero: boolean): string => {
  if (text.length >= width) return text;
  if (left) return text + ' '.repeat(width - text.length);
  if (zero) {
    const sign = /^[+\- ]/.test(text) ? text[0] : '';
    const rest = sign ? text.slice(1) : text;
    const prefix = /^0[xX]/.test(rest) ? rest.slice(0, 2) : '';
    return sign + prefix + '0'.repeat(width - text.length) + rest.slice(prefix.length);
  }
  return ' '.repeat(width - text.length) + text;
};

/**
 * `toFixed` as C's printf rounds: an exact tie goes to the even digit (2.25 at %.1f is 2.2), where
 * JavaScript rounds it up. A double's decimal expansion is finite, so `toFixed(100)` shows whether
 * the digits past the precision are exactly one half.
 */
const cFixed = (n: number, precision: number): string => {
  const rounded = n.toFixed(precision);
  if (precision >= 100 || Math.abs(n) >= 1e21) return rounded;
  const exact = n.toFixed(100);
  const dot = exact.indexOf('.');
  const tail = exact.slice(dot + 1 + precision);
  if (!/^50*$/.test(tail)) return rounded;
  // A tie: keep the truncated digits when the last one is even, as toFixed would not.
  const truncated = exact.slice(0, precision === 0 ? dot : dot + 1 + precision);
  const lastDigit = Number(truncated.replace('.', '').slice(-1));
  return lastDigit % 2 === 0 ? truncated : rounded;
};

/** `toExponential` in C's shape: two exponent digits at least, `e+05`. */
const cExponential = (n: number, precision: number, upper: boolean): string => {
  const [mantissa, exponent] = n.toExponential(precision).split('e');
  const sign = exponent[0] === '-' ? '-' : '+';
  const digits = exponent.replace(/^[+-]/, '').padStart(2, '0');
  const out = `${mantissa}e${sign}${digits}`;
  return upper ? out.toUpperCase() : out;
};

const cGeneral = (n: number, precision: number, upper: boolean, alt: boolean): string => {
  if (n === 0) return alt ? (0).toFixed(Math.max(precision - 1, 0)) : '0';
  const p = precision === 0 ? 1 : precision;
  const exponent = Math.floor(Math.log10(Math.abs(n)));
  // Rounding can carry into the next power of ten: 9.9999995 at %g is 10, not 9.99999.
  const rounded = Number(n.toExponential(p - 1));
  const x = rounded === 0 ? exponent : Math.floor(Math.log10(Math.abs(rounded)));
  let out: string;
  if (x < -4 || x >= p) {
    out = cExponential(n, p - 1, upper);
    if (!alt) out = out.replace(/\.?0+(?=[eE])/, '');
  } else {
    out = cFixed(n, Math.max(p - 1 - x, 0));
    if (!alt && out.includes('.')) out = out.replace(/\.?0+$/, '');
  }
  return out;
};

const nonFinite = (n: number): string => (Number.isNaN(n) ? 'nan' : n < 0 ? '-inf' : 'inf');

/** C's printf over awk values: `args` are consumed in order, missing ones are "" or 0. */
function sprintf(format: string, args: Value[], convfmt = '%.6g'): string {
  let out = '';
  let next = 0;
  const arg = (): Value => (next < args.length ? args[next++] : UNINIT);
  for (let i = 0; i < format.length; i++) {
    const c = format[i];
    if (c !== '%') {
      out += c;
      continue;
    }
    if (format[i + 1] === '%') {
      out += '%';
      i++;
      continue;
    }
    const spec = /^%([-+ #0]*)(\*|\d+)?(?:\.(\*|\d*))?([diouxXcseEfFgG])/.exec(format.slice(i));
    if (!spec) {
      out += c;
      continue;
    }
    i += spec[0].length - 1;
    const flags = spec[1];
    let width = spec[2] === '*' ? Math.trunc(toNum(arg())) : spec[2] ? Number(spec[2]) : 0;
    let left = flags.includes('-');
    if (width < 0) {
      left = true;
      width = -width;
    }
    const precisionRaw = spec[3] === '*' ? String(Math.trunc(toNum(arg()))) : spec[3];
    const precision = precisionRaw === undefined ? undefined : Number(precisionRaw || '0');
    const plus = flags.includes('+');
    const space = flags.includes(' ');
    const alt = flags.includes('#');
    const zero = flags.includes('0') && !left;
    const conv = spec[4];
    const value = arg();
    const signed = (text: string, negative: boolean) => (negative ? '-' : plus ? '+' : space ? ' ' : '') + text;

    switch (conv) {
      case 'd':
      case 'i': {
        const n = Math.trunc(toNum(value));
        if (!Number.isFinite(n)) {
          out += pad(nonFinite(n), width, left, false);
          break;
        }
        let digits = Math.abs(n).toLocaleString('en-US', { useGrouping: false, maximumFractionDigits: 0 });
        if (precision !== undefined) digits = precision === 0 && n === 0 ? '' : digits.padStart(precision, '0');
        out += pad(signed(digits, n < 0), width, left, zero && precision === undefined);
        break;
      }
      case 'o':
      case 'u':
      case 'x':
      case 'X': {
        let n = Math.trunc(toNum(value));
        if (n < 0) n = 2 ** 64 + n;
        const radix = conv === 'o' ? 8 : conv === 'u' ? 10 : 16;
        let digits = n.toString(radix);
        if (conv === 'X') digits = digits.toUpperCase();
        if (precision !== undefined) digits = precision === 0 && n === 0 ? '' : digits.padStart(precision, '0');
        if (alt && conv === 'o' && !digits.startsWith('0')) digits = '0' + digits;
        if (alt && n !== 0 && (conv === 'x' || conv === 'X')) digits = (conv === 'x' ? '0x' : '0X') + digits;
        out += pad(digits, width, left, zero && precision === undefined);
        break;
      }
      case 'c': {
        const text = isNumericValue(value) && typeof value !== 'string' ? String.fromCodePoint(Math.trunc(toNum(value)) || 0) : toStr(value, convfmt).slice(0, 1);
        out += pad(text, width, left, false);
        break;
      }
      case 's': {
        let text = toStr(value, convfmt);
        if (precision !== undefined) text = text.slice(0, precision);
        out += pad(text, width, left, false);
        break;
      }
      case 'e':
      case 'E':
      case 'f':
      case 'F':
      case 'g':
      case 'G': {
        const n = toNum(value);
        if (!Number.isFinite(n)) {
          out += pad(signed(Number.isNaN(n) ? 'nan' : 'inf', n < 0), width, left, false);
          break;
        }
        const p = precision ?? 6;
        const abs = Math.abs(n);
        const text = conv === 'e' || conv === 'E'
          ? cExponential(abs, p, conv === 'E')
          : conv === 'f' || conv === 'F'
          ? (alt && p === 0 ? cFixed(abs, 0) + '.' : cFixed(abs, p))
          : cGeneral(abs, p, conv === 'G', alt);
        out += pad(signed(text, n < 0 || Object.is(n, -0)), width, left, zero);
        break;
      }
    }
  }
  return out;
}

function toStr(v: Value, convfmt = '%.6g'): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return numberString(v, convfmt);
  return v.s;
}

// ---------------------------------------------------------------------------------------------
// Regexes
// ---------------------------------------------------------------------------------------------

const POSIX_CLASSES: Record<string, string> = {
  alpha: 'A-Za-z',
  digit: '0-9',
  alnum: 'A-Za-z0-9',
  upper: 'A-Z',
  lower: 'a-z',
  space: ' \\t\\n\\r\\f\\v',
  blank: ' \\t',
  punct: '!-\\/:-@\\[-`{-~',
  xdigit: '0-9A-Fa-f',
  cntrl: '\\x00-\\x1f\\x7f',
  print: '\\x20-\\x7e',
  graph: '\\x21-\\x7e',
};

const regexCache = new Map<string, RegExp>();

/** An awk ERE as a JavaScript RegExp, cached; `global` for sub, gsub and split. */
const compileRegex = (source: string, global = false): RegExp => {
  const key = (global ? 'g' : '') + source;
  let re = regexCache.get(key);
  if (!re) {
    const translated = source.replace(/\[:([a-z]+):\]/g, (whole, name: string) => POSIX_CLASSES[name] ?? whole);
    try {
      re = new RegExp(translated, global ? 'g' : '');
    } catch (error) {
      throw new AwkError(`invalid regex /${source}/: ${(error as Error).message}`);
    }
    regexCache.set(key, re);
  }
  re.lastIndex = 0;
  return re;
};

// ---------------------------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------------------------

class AwkError extends Error {}

type TokenType = 'number' | 'string' | 'regex' | 'name' | 'funcname' | 'builtin' | 'keyword' | 'op' | 'newline' | 'eof';
type Token = { type: TokenType; value: string; line: number };

const KEYWORDS = new Set([
  'BEGIN',
  'END',
  'function',
  'func',
  'if',
  'else',
  'while',
  'for',
  'do',
  'break',
  'continue',
  'next',
  'nextfile',
  'exit',
  'return',
  'delete',
  'in',
  'print',
  'printf',
  'getline',
]);

const BUILTINS = new Set([
  'length',
  'substr',
  'index',
  'split',
  'sub',
  'gsub',
  'match',
  'sprintf',
  'tolower',
  'toupper',
  'int',
  'sqrt',
  'exp',
  'log',
  'sin',
  'cos',
  'atan2',
  'rand',
  'srand',
  'close',
  'fflush',
  'system',
]);

const OPERATORS = [
  '+=',
  '-=',
  '*=',
  '/=',
  '%=',
  '^=',
  '**=',
  '==',
  '<=',
  '>=',
  '!=',
  '++',
  '--',
  '&&',
  '||',
  '>>',
  '!~',
  '**',
  '{',
  '}',
  '(',
  ')',
  '[',
  ']',
  ';',
  ',',
  '+',
  '-',
  '*',
  '/',
  '%',
  '^',
  '!',
  '>',
  '<',
  '|',
  '?',
  ':',
  '~',
  '$',
  '=',
];

const ESCAPES: Record<string, string> = { n: '\n', t: '\t', r: '\r', '\\': '\\', '"': '"', '/': '/', a: '\x07', b: '\b', f: '\f', v: '\v' };

/** After these a `/` divides; anywhere else it starts a regex. */
const ENDS_OPERAND = (token: Token | undefined): boolean =>
  !!token && (token.type === 'number' || token.type === 'string' || token.type === 'regex' || token.type === 'name' || token.type === 'builtin' ||
    (token.type === 'op' && (token.value === ')' || token.value === ']' || token.value === '$' || token.value === '++' || token.value === '--')));

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  const push = (type: TokenType, value: string) => tokens.push({ type, value, line });

  while (i < src.length) {
    const c = src[i];
    if (c === '\\' && src[i + 1] === '\n') {
      i += 2;
      line++;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      i++;
      continue;
    }
    if (c === '\n') {
      push('newline', '\n');
      i++;
      line++;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '"') {
      let value = '';
      i++;
      while (i < src.length && src[i] !== '"') {
        if (src[i] === '\\' && i + 1 < src.length) {
          const e = src[i + 1];
          if (/[0-7]/.test(e)) {
            const oct = /^[0-7]{1,3}/.exec(src.slice(i + 1))![0];
            value += String.fromCharCode(parseInt(oct, 8));
            i += 1 + oct.length;
            continue;
          }
          value += ESCAPES[e] ?? '\\' + e;
          i += 2;
          continue;
        }
        if (src[i] === '\n') throw new AwkError(`newline in string at line ${line}`);
        value += src[i++];
      }
      if (src[i] !== '"') throw new AwkError(`unterminated string at line ${line}`);
      i++;
      push('string', value);
      continue;
    }
    if (c === '/' && !ENDS_OPERAND(tokens[tokens.length - 1])) {
      let value = '';
      let inBracket = false;
      i++;
      while (i < src.length && (src[i] !== '/' || inBracket)) {
        if (src[i] === '\n') throw new AwkError(`newline in regex at line ${line}`);
        if (src[i] === '\\' && i + 1 < src.length) {
          value += src[i + 1] === '/' ? '/' : src[i] + src[i + 1];
          i += 2;
          continue;
        }
        if (src[i] === '[') inBracket = true;
        else if (src[i] === ']') inBracket = false;
        value += src[i++];
      }
      if (src[i] !== '/') throw new AwkError(`unterminated regex at line ${line}`);
      i++;
      push('regex', value);
      continue;
    }
    const number = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(src.slice(i));
    if (number) {
      push('number', number[0]);
      i += number[0].length;
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i));
    if (word) {
      const w = word[0];
      i += w.length;
      if (KEYWORDS.has(w)) push('keyword', w === 'func' ? 'function' : w);
      else if (BUILTINS.has(w)) push('builtin', w);
      else if (src[i] === '(') push('funcname', w);
      else push('name', w);
      continue;
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i));
    if (!op) throw new AwkError(`unexpected character '${c}' at line ${line}`);
    push('op', op === '**' ? '^' : op === '**=' ? '^=' : op);
    i += op.length;
  }
  push('eof', '');
  return tokens;
}

// ---------------------------------------------------------------------------------------------
// Syntax tree
// ---------------------------------------------------------------------------------------------

type Expr =
  | { k: 'num'; v: number }
  | { k: 'str'; v: string }
  | { k: 'regex'; v: string }
  | { k: 'var'; name: string }
  | { k: 'field'; index: Expr }
  | { k: 'index'; name: string; subs: Expr[] }
  | { k: 'assign'; op: string; target: Expr; value: Expr }
  | { k: 'cond'; test: Expr; yes: Expr; no: Expr }
  | { k: 'or' | 'and'; left: Expr; right: Expr }
  | { k: 'in'; subs: Expr[]; name: string }
  | { k: 'match'; negate: boolean; left: Expr; right: Expr }
  | { k: 'cmp'; op: string; left: Expr; right: Expr }
  | { k: 'concat'; left: Expr; right: Expr }
  | { k: 'arith'; op: string; left: Expr; right: Expr }
  | { k: 'unary'; op: string; arg: Expr }
  | { k: 'incdec'; op: string; prefix: boolean; target: Expr }
  | { k: 'group'; list: Expr[] }
  | { k: 'builtin'; name: string; args: Expr[] }
  | { k: 'call'; name: string; args: Expr[] };

type Output = { kind: 'stdout' | 'stderr' | 'unsupported'; target?: Expr; mode?: string };

type Stmt =
  | { k: 'block'; body: Stmt[] }
  | { k: 'expr'; expr: Expr }
  | { k: 'print'; args: Expr[]; out?: Output }
  | { k: 'printf'; args: Expr[]; out?: Output }
  | { k: 'if'; test: Expr; yes: Stmt; no?: Stmt }
  | { k: 'while'; test: Expr; body: Stmt }
  | { k: 'do'; body: Stmt; test: Expr }
  | { k: 'for'; init?: Expr; test?: Expr; step?: Expr; body: Stmt }
  | { k: 'forin'; key: string; array: string; body: Stmt }
  | { k: 'delete'; name: string; subs?: Expr[] }
  | { k: 'next' | 'break' | 'continue' | 'nextfile' }
  | { k: 'exit'; code?: Expr }
  | { k: 'return'; value?: Expr };

type Pattern =
  | { k: 'begin' }
  | { k: 'end' }
  | { k: 'all' }
  | { k: 'expr'; expr: Expr }
  | { k: 'range'; from: Expr; to: Expr; active: boolean };

type Rule = { pattern: Pattern; action?: Stmt[] };
type Func = { params: string[]; body: Stmt[] };
type Program = { rules: Rule[]; funcs: Map<string, Func> };

// ---------------------------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------------------------

const LVALUE = new Set(['var', 'field', 'index']);
const ASSIGN_OPS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '^=']);
const COMPARE_OPS = new Set(['<', '<=', '>', '>=', '==', '!=']);

class Parser {
  private pos = 0;
  constructor(private tokens: Token[]) {}

  private get tok(): Token {
    return this.tokens[this.pos];
  }

  private is(value: string, type: TokenType = 'op'): boolean {
    return this.tok.type === type && this.tok.value === value;
  }

  private isKeyword(value: string): boolean {
    return this.is(value, 'keyword');
  }

  private advance(): Token {
    return this.tokens[this.pos++];
  }

  private expect(value: string, type: TokenType = 'op'): Token {
    if (!this.is(value, type)) throw this.error(`expected '${value}'`);
    return this.advance();
  }

  private error(message: string): AwkError {
    const t = this.tok;
    const near = t.type === 'eof' ? 'end of program' : t.type === 'newline' ? 'newline' : `'${t.value}'`;
    return new AwkError(`syntax error at line ${t.line} near ${near}: ${message}`);
  }

  private newlines(): void {
    while (this.tok.type === 'newline') this.advance();
  }

  /** Statement ends: `;`, newlines, or nothing before `}` and the end. */
  private terminators(): void {
    while (this.tok.type === 'newline' || this.is(';')) this.advance();
  }

  parseProgram(): Program {
    const rules: Rule[] = [];
    const funcs = new Map<string, Func>();
    this.terminators();
    while (this.tok.type !== 'eof') {
      if (this.isKeyword('function')) {
        this.advance();
        const nameTok = this.advance();
        if (nameTok.type !== 'funcname' && nameTok.type !== 'name') throw this.error('expected a function name');
        this.expect('(');
        const params: string[] = [];
        while (!this.is(')')) {
          const p = this.advance();
          if (p.type !== 'name') throw this.error('expected a parameter name');
          params.push(p.value);
          if (this.is(',')) {
            this.advance();
            this.newlines();
          } else if (!this.is(')')) throw this.error("expected ',' or ')'");
        }
        this.advance();
        this.newlines();
        funcs.set(nameTok.value, { params, body: this.parseBlock() });
      } else if (this.isKeyword('BEGIN') || this.isKeyword('END')) {
        const kind = this.advance().value === 'BEGIN' ? 'begin' : 'end';
        this.newlines();
        if (!this.is('{')) throw this.error(`${kind.toUpperCase()} needs an action`);
        rules.push({ pattern: { k: kind }, action: this.parseBlock() });
      } else if (this.is('{')) {
        rules.push({ pattern: { k: 'all' }, action: this.parseBlock() });
      } else {
        const from = this.parseExpr();
        let pattern: Pattern = { k: 'expr', expr: from };
        if (this.is(',')) {
          this.advance();
          this.newlines();
          pattern = { k: 'range', from, to: this.parseExpr(), active: false };
        }
        rules.push({ pattern, action: this.is('{') ? this.parseBlock() : undefined });
      }
      this.terminators();
    }
    return { rules, funcs };
  }

  private parseBlock(): Stmt[] {
    this.expect('{');
    const body: Stmt[] = [];
    this.terminators();
    while (!this.is('}')) {
      if (this.tok.type === 'eof') throw this.error("missing '}'");
      body.push(this.parseStatement());
      this.terminators();
    }
    this.advance();
    return body;
  }

  /** A statement's end: `;`, a newline, or a following `}`, which is left for the block. */
  private endSimple(): void {
    if (this.is(';') || this.tok.type === 'newline') {
      this.advance();
      return;
    }
    if (this.is('}') || this.tok.type === 'eof') return;
    throw this.error('expected the end of the statement');
  }

  /** The body of if, while and for: a statement after optional newlines. */
  private parseBody(): Stmt {
    this.newlines();
    if (this.is(';')) {
      this.advance();
      return { k: 'block', body: [] };
    }
    return this.parseStatement();
  }

  private parseStatement(): Stmt {
    if (this.is('{')) return { k: 'block', body: this.parseBlock() };
    if (this.tok.type === 'keyword') {
      switch (this.tok.value) {
        case 'if': {
          this.advance();
          this.expect('(');
          const test = this.parseExpr();
          this.expect(')');
          const yes = this.parseBody();
          // `else` may follow on the next line, or after the `;` that ended a simple statement.
          const save = this.pos;
          this.terminators();
          if (this.isKeyword('else')) {
            this.advance();
            return { k: 'if', test, yes, no: this.parseBody() };
          }
          this.pos = save;
          return { k: 'if', test, yes };
        }
        case 'while': {
          this.advance();
          this.expect('(');
          const test = this.parseExpr();
          this.expect(')');
          if (this.is(';')) {
            this.advance();
            return { k: 'while', test, body: { k: 'block', body: [] } };
          }
          return { k: 'while', test, body: this.parseBody() };
        }
        case 'do': {
          this.advance();
          const body = this.parseBody();
          this.terminators();
          if (!this.isKeyword('while')) throw this.error("expected 'while' after the do body");
          this.advance();
          this.expect('(');
          const test = this.parseExpr();
          this.expect(')');
          this.endSimple();
          return { k: 'do', body, test };
        }
        case 'for': {
          this.advance();
          this.expect('(');
          const t = this.tokens;
          if (t[this.pos].type === 'name' && t[this.pos + 1].value === 'in' && t[this.pos + 2].type === 'name' && t[this.pos + 3].value === ')') {
            const key = this.advance().value;
            this.advance();
            const array = this.advance().value;
            this.advance();
            return { k: 'forin', key, array, body: this.parseBody() };
          }
          const init = this.is(';') ? undefined : this.parseExpr();
          this.expect(';');
          this.newlines();
          const test = this.is(';') ? undefined : this.parseExpr();
          this.expect(';');
          this.newlines();
          const step = this.is(')') ? undefined : this.parseExpr();
          this.expect(')');
          return { k: 'for', init, test, step, body: this.parseBody() };
        }
        case 'break':
        case 'continue':
        case 'next':
        case 'nextfile': {
          const k = this.advance().value as 'break' | 'continue' | 'next' | 'nextfile';
          this.endSimple();
          return { k };
        }
        case 'exit': {
          this.advance();
          const code = this.startsExpr() ? this.parseExpr() : undefined;
          this.endSimple();
          return { k: 'exit', code };
        }
        case 'return': {
          this.advance();
          const value = this.startsExpr() ? this.parseExpr() : undefined;
          this.endSimple();
          return { k: 'return', value };
        }
        case 'delete': {
          this.advance();
          const name = this.advance();
          if (name.type !== 'name') throw this.error('delete takes an array');
          let subs: Expr[] | undefined;
          if (this.is('[')) {
            this.advance();
            subs = this.parseExprList(']');
            this.expect(']');
          }
          this.endSimple();
          return { k: 'delete', name: name.value, subs };
        }
        case 'print':
        case 'printf': {
          const kind = this.advance().value as 'print' | 'printf';
          let args: Expr[] = [];
          if (this.startsExpr()) {
            args = [this.parseExpr(true)];
            while (this.is(',')) {
              this.advance();
              this.newlines();
              args.push(this.parseExpr(true));
            }
          }
          // `print (a, b)`: the parenthesized list is the argument list.
          if (args.length === 1 && args[0].k === 'group') args = args[0].list;
          let out: Output | undefined;
          if (this.is('>') || this.is('>>') || this.is('|')) {
            const mode = this.advance().value;
            const target = this.parseConcat();
            out = { kind: 'unsupported', target, mode };
            if (mode !== '|' && target.k === 'str' && target.v === '/dev/stderr') out = { kind: 'stderr' };
            if (mode !== '|' && target.k === 'str' && target.v === '/dev/stdout') out = { kind: 'stdout' };
          }
          if (kind === 'printf' && args.length === 0) throw this.error('printf needs a format');
          this.endSimple();
          return { k: kind, args, out };
        }
        case 'getline':
          throw this.error('getline is not supported');
      }
    }
    if (this.is(';')) {
      this.advance();
      return { k: 'block', body: [] };
    }
    const expr = this.parseExpr();
    this.endSimple();
    return { k: 'expr', expr };
  }

  private startsExpr(): boolean {
    const t = this.tok;
    if (t.type === 'number' || t.type === 'string' || t.type === 'regex' || t.type === 'name' || t.type === 'funcname' || t.type === 'builtin') return true;
    return t.type === 'op' && ['$', '(', '!', '-', '+', '++', '--'].includes(t.value);
  }

  private parseExprList(close: string): Expr[] {
    const list = [this.parseExpr()];
    while (this.is(',')) {
      this.advance();
      this.newlines();
      list.push(this.parseExpr());
    }
    if (!this.is(close)) throw this.error(`expected '${close}'`);
    return list;
  }

  /** `noGt`: in print's arguments a bare `>` is output redirection, not a comparison. */
  parseExpr(noGt = false): Expr {
    const left = this.parseTernary(noGt);
    if (this.tok.type === 'op' && ASSIGN_OPS.has(this.tok.value)) {
      if (!LVALUE.has(left.k)) throw this.error('assignment to a non-variable');
      const op = this.advance().value;
      this.newlines();
      return { k: 'assign', op, target: left, value: this.parseExpr(noGt) };
    }
    return left;
  }

  private parseTernary(noGt: boolean): Expr {
    const test = this.parseOr(noGt);
    if (!this.is('?')) return test;
    this.advance();
    this.newlines();
    const yes = this.parseExpr(noGt);
    this.newlines();
    this.expect(':');
    this.newlines();
    const no = this.parseExpr(noGt);
    return { k: 'cond', test, yes, no };
  }

  private parseOr(noGt: boolean): Expr {
    let left = this.parseAnd(noGt);
    while (this.is('||')) {
      this.advance();
      this.newlines();
      left = { k: 'or', left, right: this.parseAnd(noGt) };
    }
    return left;
  }

  private parseAnd(noGt: boolean): Expr {
    let left = this.parseIn(noGt);
    while (this.is('&&')) {
      this.advance();
      this.newlines();
      left = { k: 'and', left, right: this.parseIn(noGt) };
    }
    return left;
  }

  private parseIn(noGt: boolean): Expr {
    let left = this.parseMatch(noGt);
    while (this.isKeyword('in')) {
      this.advance();
      const name = this.advance();
      if (name.type !== 'name') throw this.error("'in' takes an array");
      left = { k: 'in', subs: left.k === 'group' ? left.list : [left], name: name.value };
    }
    return left;
  }

  private parseMatch(noGt: boolean): Expr {
    let left = this.parseCompare(noGt);
    while (this.is('~') || this.is('!~')) {
      const negate = this.advance().value === '!~';
      left = { k: 'match', negate, left, right: this.parseCompare(noGt) };
    }
    return left;
  }

  private parseCompare(noGt: boolean): Expr {
    const left = this.parseConcat();
    if (this.tok.type === 'op' && COMPARE_OPS.has(this.tok.value) && !(noGt && this.tok.value === '>')) {
      const op = this.advance().value;
      return { k: 'cmp', op, left, right: this.parseConcat() };
    }
    return left;
  }

  /** Juxtaposition: `a b` is "ab". Any token that can start an operand continues it. */
  parseConcat(): Expr {
    let left = this.parseAdditive();
    while (this.startsConcatOperand()) {
      left = { k: 'concat', left, right: this.parseAdditive() };
    }
    return left;
  }

  private startsConcatOperand(): boolean {
    const t = this.tok;
    if (t.type === 'number' || t.type === 'string' || t.type === 'regex' || t.type === 'name' || t.type === 'funcname' || t.type === 'builtin') return true;
    return t.type === 'op' && ['$', '(', '!', '++', '--'].includes(t.value) && !(t.value === '!' && this.tokens[this.pos + 1]?.value === '=');
  }

  private parseAdditive(): Expr {
    let left = this.parseMultiplicative();
    while (this.is('+') || this.is('-')) {
      const op = this.advance().value;
      left = { k: 'arith', op, left, right: this.parseMultiplicative() };
    }
    return left;
  }

  private parseMultiplicative(): Expr {
    let left = this.parseUnary();
    while (this.is('*') || this.is('/') || this.is('%')) {
      const op = this.advance().value;
      left = { k: 'arith', op, left, right: this.parseUnary() };
    }
    return left;
  }

  private parseUnary(): Expr {
    if (this.is('!') || this.is('-') || this.is('+')) {
      const op = this.advance().value;
      return { k: 'unary', op, arg: this.parseUnary() };
    }
    return this.parsePower();
  }

  private parsePower(): Expr {
    const base = this.parseIncDec();
    if (this.is('^')) {
      this.advance();
      // Right-associative, and binds tighter than a unary minus on its right: 2^-1.
      const exponent = this.is('-') || this.is('+') || this.is('!') ? this.parseUnary() : this.parsePower();
      return { k: 'arith', op: '^', left: base, right: exponent };
    }
    return base;
  }

  private parseIncDec(): Expr {
    if (this.is('++') || this.is('--')) {
      const op = this.advance().value;
      const target = this.parseIncDec();
      if (!LVALUE.has(target.k)) throw this.error(`${op} needs a variable`);
      return { k: 'incdec', op, prefix: true, target };
    }
    const expr = this.parsePrimary();
    if ((this.is('++') || this.is('--')) && LVALUE.has(expr.k)) {
      const op = this.advance().value;
      return { k: 'incdec', op, prefix: false, target: expr };
    }
    return expr;
  }

  private parsePrimary(): Expr {
    const t = this.tok;
    switch (t.type) {
      case 'number':
        this.advance();
        return { k: 'num', v: Number(t.value) };
      case 'string':
        this.advance();
        return { k: 'str', v: t.value };
      case 'regex':
        this.advance();
        return { k: 'regex', v: t.value };
      case 'name':
        this.advance();
        if (this.is('[')) {
          this.advance();
          const subs = this.parseExprList(']');
          this.advance();
          return { k: 'index', name: t.value, subs };
        }
        return { k: 'var', name: t.value };
      case 'funcname': {
        this.advance();
        this.expect('(');
        const args = this.is(')') ? [] : this.parseExprList(')');
        this.advance();
        return { k: 'call', name: t.value, args };
      }
      case 'builtin': {
        this.advance();
        if (t.value === 'system') throw this.error('system() is not supported');
        if (!this.is('(')) {
          if (t.value === 'length') return { k: 'builtin', name: 'length', args: [] };
          throw this.error(`${t.value} needs its arguments in parentheses`);
        }
        this.advance();
        const args = this.is(')') ? [] : this.parseExprList(')');
        this.advance();
        return { k: 'builtin', name: t.value, args };
      }
      case 'keyword':
        if (t.value === 'getline') throw this.error('getline is not supported');
        break;
      case 'op':
        if (t.value === '$') {
          this.advance();
          const index = this.is('++') || this.is('--') ? this.parseIncDec() : this.is('-') ? this.parseUnary() : this.parsePrimary();
          return { k: 'field', index };
        }
        if (t.value === '(') {
          this.advance();
          this.newlines();
          const list = [this.parseExpr()];
          while (this.is(',')) {
            this.advance();
            this.newlines();
            list.push(this.parseExpr());
          }
          this.newlines();
          this.expect(')');
          if (list.length > 1) {
            if (!this.isKeyword('in') && !this.canEndPrintList()) throw this.error("a parenthesized list must be followed by 'in'");
            return { k: 'group', list };
          }
          return { k: 'group', list };
        }
        break;
    }
    throw this.error('expected an expression');
  }

  /** `print (a, b)` ends the statement right after the list, or redirects it. */
  private canEndPrintList(): boolean {
    return this.is(';') || this.is('}') || this.tok.type === 'newline' || this.tok.type === 'eof' || this.is('>') || this.is('>>') || this.is('|');
  }
}

// ---------------------------------------------------------------------------------------------
// Interpreter
// ---------------------------------------------------------------------------------------------

class NextSignal {}
class NextFileSignal {}
class ExitSignal {}
class BreakSignal {}
class ContinueSignal {}
class ReturnSignal {
  constructor(public value: Value) {}
}

type Frame = Map<string, Value | AwkArray>;

type Io = {
  write: (text: string) => Promise<void>;
  writeError: (text: string) => Promise<void>;
  interrupted: () => boolean;
};

const SPECIAL = new Set(['NF', 'NR', 'FNR', 'FS', 'OFS', 'ORS', 'RS', 'FILENAME', 'SUBSEP', 'RSTART', 'RLENGTH', 'CONVFMT', 'OFMT']);

class Interpreter {
  globals: Frame = new Map();
  private frames: Frame[] = [];
  private record = '';
  private fields: string[] | null = null;
  exitCode = 0;
  private out = '';
  private seed = 0;
  private prevSeed = 0;
  private callDepth = 0;

  constructor(private program: Program, private io: Io) {
    const g = this.globals;
    g.set('FS', ' ');
    g.set('OFS', ' ');
    g.set('ORS', '\n');
    g.set('RS', '\n');
    g.set('NR', 0);
    g.set('FNR', 0);
    g.set('SUBSEP', '\x1c');
    g.set('RSTART', 0);
    g.set('RLENGTH', -1);
    g.set('CONVFMT', '%.6g');
    g.set('OFMT', '%.6g');
    g.set('FILENAME', '');
  }

  // --- output -------------------------------------------------------------------------------

  private async emit(text: string, stderr = false): Promise<void> {
    if (stderr) {
      await this.flush();
      await this.io.writeError(text);
      return;
    }
    this.out += text;
    if (this.out.length > 65536) await this.flush();
  }

  async flush(): Promise<void> {
    if (this.out) {
      const text = this.out;
      this.out = '';
      await this.io.write(text);
    }
  }

  // --- variables ----------------------------------------------------------------------------

  private str(v: Value): string {
    return toStr(v, toStr(this.globals.get('CONVFMT') as Value));
  }

  private frameOf(name: string): Frame {
    const frame = this.frames[this.frames.length - 1];
    return frame && frame.has(name) ? frame : this.globals;
  }

  /** A parameter given an unset name is an empty array until the function uses it as a scalar. */
  private isLazy(frame: Frame, name: string): boolean {
    const v = frame.get(name);
    return v instanceof Map && v.size === 0 && frame.has(`\0lazy:${name}`);
  }

  private getVar(name: string): Value {
    if (name === 'NF') return this.splitFields().length;
    const frame = this.frameOf(name);
    const v = frame.get(name);
    if (this.isLazy(frame, name)) return UNINIT;
    if (v instanceof Map) throw new AwkError(`can't use array ${name} in a scalar context`);
    return v ?? UNINIT;
  }

  private setVar(name: string, value: Value): void {
    if (name === 'NF') {
      const n = Math.max(0, Math.trunc(toNum(value)));
      const fields = this.splitFields();
      while (fields.length < n) fields.push('');
      fields.length = n;
      this.rebuild();
      return;
    }
    const frame = this.frameOf(name);
    if (frame.get(name) instanceof Map && !this.isLazy(frame, name)) throw new AwkError(`can't assign to array ${name}`);
    frame.set(name, value);
  }

  private getArray(name: string): AwkArray {
    const frame = this.frameOf(name);
    let a = frame.get(name);
    if (a === undefined || (isStrNum(a as Value) && a === UNINIT)) {
      a = new Map();
      frame.set(name, a);
    }
    if (!(a instanceof Map)) throw new AwkError(`can't use scalar ${name} as an array`);
    return a;
  }

  private async subscript(subs: Expr[]): Promise<string> {
    const parts: string[] = [];
    for (const s of subs) parts.push(this.str(await this.eval(s)));
    return parts.join(this.str(this.getVar('SUBSEP')));
  }

  // --- records and fields -------------------------------------------------------------------

  setRecord(text: string): void {
    this.record = text;
    this.fields = null;
  }

  private splitFields(): string[] {
    if (!this.fields) this.fields = splitWith(this.record, this.str(this.getVar('FS')), this.str(this.getVar('RS')) === '');
    return this.fields;
  }

  private rebuild(): void {
    this.record = this.splitFields().join(this.str(this.getVar('OFS')));
  }

  private getField(i: number): Value {
    if (i < 0) throw new AwkError(`attempt to access field ${i}`);
    if (i === 0) return strnum(this.record);
    const f = this.splitFields()[i - 1];
    return f === undefined ? UNINIT : strnum(f);
  }

  private setField(i: number, value: Value): void {
    if (i < 0) throw new AwkError(`attempt to access field ${i}`);
    if (i === 0) {
      this.setRecord(this.str(value));
      return;
    }
    const fields = this.splitFields();
    while (fields.length < i) fields.push('');
    fields[i - 1] = this.str(value);
    this.rebuild();
  }

  // --- lvalues ------------------------------------------------------------------------------

  private async read(target: Expr): Promise<Value> {
    return this.eval(target);
  }

  private async write(target: Expr, value: Value): Promise<void> {
    if (target.k === 'var') this.setVar(target.name, value);
    else if (target.k === 'field') this.setField(Math.trunc(toNum(await this.eval(target.index))), value);
    else if (target.k === 'index') this.getArray(target.name).set(await this.subscript(target.subs), value);
  }

  // --- expressions --------------------------------------------------------------------------

  async eval(e: Expr): Promise<Value> {
    switch (e.k) {
      case 'num':
        return e.v;
      case 'str':
        return e.v;
      case 'regex':
        return compileRegex(e.v).test(this.record) ? 1 : 0;
      case 'var':
        return this.getVar(e.name);
      case 'field':
        return this.getField(Math.trunc(toNum(await this.eval(e.index))));
      case 'index': {
        const a = this.getArray(e.name);
        const key = await this.subscript(e.subs);
        let v = a.get(key);
        if (v === undefined) {
          // Referencing an element creates it, as in awk.
          v = UNINIT;
          a.set(key, v);
        }
        return v;
      }
      case 'group':
        if (e.list.length > 1) throw new AwkError('a parenthesized list is only valid before in');
        return this.eval(e.list[0]);
      case 'assign': {
        let value: Value;
        if (e.op === '=') {
          value = await this.eval(e.value);
          // A copied field keeps its strnum nature; a copied array element too.
        } else {
          const right = toNum(await this.eval(e.value));
          const left = toNum(await this.read(e.target));
          value = arith(e.op[0], left, right);
        }
        await this.write(e.target, value);
        return value;
      }
      case 'cond':
        return truthy(await this.eval(e.test)) ? this.eval(e.yes) : this.eval(e.no);
      case 'or':
        return truthy(await this.eval(e.left)) || truthy(await this.eval(e.right)) ? 1 : 0;
      case 'and':
        return truthy(await this.eval(e.left)) && truthy(await this.eval(e.right)) ? 1 : 0;
      case 'in':
        return this.getArray(e.name).has(await this.subscript(e.subs)) ? 1 : 0;
      case 'match': {
        const text = this.str(await this.eval(e.left));
        const re = await this.regexOf(e.right);
        return re.test(text) !== e.negate ? 1 : 0;
      }
      case 'cmp':
        return compare(e.op, await this.eval(e.left), await this.eval(e.right), (v) => this.str(v)) ? 1 : 0;
      case 'concat':
        return this.str(await this.eval(e.left)) + this.str(await this.eval(e.right));
      case 'arith':
        return arith(e.op, toNum(await this.eval(e.left)), toNum(await this.eval(e.right)));
      case 'unary': {
        const v = await this.eval(e.arg);
        if (e.op === '!') return truthy(v) ? 0 : 1;
        return e.op === '-' ? -toNum(v) : toNum(v);
      }
      case 'incdec': {
        const old = toNum(await this.read(e.target));
        const updated = e.op === '++' ? old + 1 : old - 1;
        await this.write(e.target, updated);
        return e.prefix ? updated : old;
      }
      case 'builtin':
        return this.builtin(e.name, e.args);
      case 'call':
        return this.call(e.name, e.args);
    }
  }

  /** The regex an operand means: a /literal/ as written, anything else as a dynamic regex string. */
  private async regexOf(e: Expr, global = false): Promise<RegExp> {
    if (e.k === 'regex') return compileRegex(e.v, global);
    return compileRegex(this.str(await this.eval(e)), global);
  }

  private async builtin(name: string, args: Expr[]): Promise<Value> {
    const n = async (i: number) => toNum(await this.eval(args[i]));
    const s = async (i: number) => this.str(await this.eval(args[i]));
    switch (name) {
      case 'length': {
        if (args.length === 0) return [...this.record].length;
        const a = args[0];
        if (a.k === 'var' && this.frameOf(a.name).get(a.name) instanceof Map) return (this.frameOf(a.name).get(a.name) as AwkArray).size;
        return [...await s(0)].length;
      }
      case 'substr': {
        const text = [...await s(0)];
        // POSIX: characters from round(m) up to, not including, round(m) + round(n).
        const m = Math.round(await n(1));
        const end = args.length > 2 ? m + Math.round(await n(2)) : Infinity;
        const from = Math.max(m, 1);
        const to = Math.min(end, text.length + 1);
        return to > from ? text.slice(from - 1, to - 1).join('') : '';
      }
      case 'index': {
        const text = await s(0);
        const find = await s(1);
        return text.indexOf(find) + 1;
      }
      case 'split': {
        const text = await s(0);
        const target = args[1];
        if (target.k !== 'var') throw new AwkError('split needs an array as its second argument');
        let parts: string[];
        if (args.length > 2) {
          const sep = args[2];
          parts = sep.k === 'regex' ? splitRegex(text, compileRegex(sep.v, true)) : splitWith(text, this.str(await this.eval(sep)), false);
        } else {
          parts = splitWith(text, this.str(this.getVar('FS')), false);
        }
        const array = this.getArray(target.name);
        array.clear();
        parts.forEach((part, i) => array.set(String(i + 1), strnum(part)));
        return parts.length;
      }
      case 'sub':
      case 'gsub': {
        const re = await this.regexOf(args[0], true);
        const replacement = await s(1);
        const target: Expr = args[2] ?? { k: 'field', index: { k: 'num', v: 0 } };
        if (!LVALUE.has(target.k)) throw new AwkError(`${name} needs a variable as its third argument`);
        const text = this.str(await this.read(target));
        const { result, count } = substitute(text, re, replacement, name === 'gsub');
        if (count > 0) await this.write(target, result);
        return count;
      }
      case 'match': {
        const text = await s(0);
        const re = await this.regexOf(args[1]);
        const m = re.exec(text);
        const start = m ? [...text.slice(0, m.index)].length + 1 : 0;
        const length = m ? [...m[0]].length : -1;
        this.globals.set('RSTART', start);
        this.globals.set('RLENGTH', length);
        return start;
      }
      case 'sprintf': {
        if (args.length === 0) throw new AwkError('sprintf needs a format');
        const values: Value[] = [];
        for (const a of args.slice(1)) values.push(await this.eval(a));
        return sprintf(await s(0), values, this.str(this.getVar('CONVFMT')));
      }
      case 'tolower':
        return (await s(0)).toLowerCase();
      case 'toupper':
        return (await s(0)).toUpperCase();
      case 'int':
        return Math.trunc(await n(0));
      case 'sqrt':
        return Math.sqrt(await n(0));
      case 'exp':
        return Math.exp(await n(0));
      case 'log':
        return Math.log(await n(0));
      case 'sin':
        return Math.sin(await n(0));
      case 'cos':
        return Math.cos(await n(0));
      case 'atan2':
        return Math.atan2(await n(0), await n(1));
      case 'rand':
        return this.random();
      case 'srand': {
        const previous = this.prevSeed;
        this.prevSeed = args.length > 0 ? await n(0) : Math.floor(Date.now() / 1000);
        this.seed = this.prevSeed;
        return previous;
      }
      case 'close':
      case 'fflush':
        for (const a of args) await this.eval(a);
        return 0;
    }
    throw new AwkError(`unknown function ${name}`);
  }

  /** A small seeded generator (mulberry32), so srand(n) repeats its sequence. */
  private random(): number {
    let t = (this.seed = (this.seed + 0x6d2b79f5) | 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  private async call(name: string, args: Expr[]): Promise<Value> {
    const fn = this.program.funcs.get(name);
    if (!fn) throw new AwkError(`calling undefined function ${name}`);
    if (args.length > fn.params.length) throw new AwkError(`function ${name} called with ${args.length} arguments, accepts ${fn.params.length}`);
    if (++this.callDepth > 1000) throw new AwkError(`function ${name}: recursion too deep`);
    const frame: Frame = new Map();
    for (let i = 0; i < fn.params.length; i++) {
      const a = args[i];
      if (a === undefined) {
        frame.set(fn.params[i], UNINIT);
        continue;
      }
      // An array argument is passed by reference; a name not yet used becomes an array the callee may fill.
      if (a.k === 'var') {
        const holder = this.frameOf(a.name);
        const current = holder.get(a.name);
        if (current instanceof Map) {
          frame.set(fn.params[i], current);
          continue;
        }
        if (current === undefined && !SPECIAL.has(a.name)) {
          const fresh: AwkArray = new Map();
          frame.set(fn.params[i], fresh);
          (frame as Map<string, unknown>).set(`\0lazy:${fn.params[i]}`, { holder, name: a.name });
          continue;
        }
      }
      frame.set(fn.params[i], await this.eval(a));
    }
    this.frames.push(frame);
    try {
      await this.execBlock(fn.body);
      return UNINIT;
    } catch (signal) {
      if (signal instanceof ReturnSignal) return signal.value;
      throw signal;
    } finally {
      this.frames.pop();
      this.callDepth--;
      // A fresh array the callee filled belongs to the caller's name now; one it used as a scalar does not.
      for (const [key, link] of frame) {
        if (!key.startsWith('\0lazy:')) continue;
        const param = key.slice('\0lazy:'.length);
        const value = frame.get(param);
        const { holder, name } = link as unknown as { holder: Frame; name: string };
        if (value instanceof Map && value.size > 0 && !holder.has(name)) holder.set(name, value);
      }
    }
  }

  // --- statements ---------------------------------------------------------------------------

  async execBlock(body: Stmt[]): Promise<void> {
    for (const s of body) await this.exec(s);
  }

  private checkInterrupt(): void {
    if (this.io.interrupted()) throw new AwkError('interrupted');
  }

  async exec(s: Stmt): Promise<void> {
    switch (s.k) {
      case 'block':
        return this.execBlock(s.body);
      case 'expr':
        await this.eval(s.expr);
        return;
      case 'print': {
        const ofs = this.str(this.getVar('OFS'));
        const ofmt = this.str(this.getVar('OFMT'));
        let line: string;
        if (s.args.length === 0) line = this.record;
        else {
          const parts: string[] = [];
          for (const a of s.args) {
            const v = await this.eval(a);
            parts.push(typeof v === 'number' ? numberString(v, ofmt) : this.str(v));
          }
          line = parts.join(ofs);
        }
        await this.output(s.out, line + this.str(this.getVar('ORS')));
        return;
      }
      case 'printf': {
        const values: Value[] = [];
        for (const a of s.args.slice(1)) values.push(await this.eval(a));
        await this.output(s.out, sprintf(this.str(await this.eval(s.args[0])), values, this.str(this.getVar('CONVFMT'))));
        return;
      }
      case 'if':
        if (truthy(await this.eval(s.test))) await this.exec(s.yes);
        else if (s.no) await this.exec(s.no);
        return;
      case 'while':
        while (truthy(await this.eval(s.test))) {
          this.checkInterrupt();
          if (await this.loopBody(s.body)) break;
        }
        return;
      case 'do':
        do {
          this.checkInterrupt();
          if (await this.loopBody(s.body)) break;
        } while (truthy(await this.eval(s.test)));
        return;
      case 'for':
        if (s.init) await this.eval(s.init);
        while (!s.test || truthy(await this.eval(s.test))) {
          this.checkInterrupt();
          if (await this.loopBody(s.body)) break;
          if (s.step) await this.eval(s.step);
        }
        return;
      case 'forin': {
        const array = this.getArray(s.array);
        for (const key of [...array.keys()]) {
          if (!array.has(key)) continue;
          this.checkInterrupt();
          this.setVar(s.key, strnum(key));
          if (await this.loopBody(s.body)) break;
        }
        return;
      }
      case 'delete': {
        const array = this.getArray(s.name);
        if (s.subs) array.delete(await this.subscript(s.subs));
        else array.clear();
        return;
      }
      case 'next':
        if (this.inBeginOrEnd) throw new AwkError('next used in BEGIN or END');
        throw new NextSignal();
      case 'nextfile':
        throw new NextFileSignal();
      case 'break':
        throw new BreakSignal();
      case 'continue':
        throw new ContinueSignal();
      case 'exit':
        if (s.code) this.exitCode = Math.trunc(toNum(await this.eval(s.code))) & 255;
        throw new ExitSignal();
      case 'return':
        if (this.frames.length === 0) throw new AwkError('return outside a function');
        throw new ReturnSignal(s.value ? await this.eval(s.value) : UNINIT);
    }
  }

  inBeginOrEnd = false;

  /** Runs a loop body; true when it broke out of the loop. */
  private async loopBody(body: Stmt): Promise<boolean> {
    try {
      await this.exec(body);
    } catch (signal) {
      if (signal instanceof BreakSignal) return true;
      if (signal instanceof ContinueSignal) return false;
      throw signal;
    }
    return false;
  }

  private async output(out: Output | undefined, text: string): Promise<void> {
    if (out?.kind === 'unsupported') {
      const target = out.target ? this.str(await this.eval(out.target)) : '';
      throw new AwkError(out.mode === '|' ? `output to a command ("${target}") is not supported` : `output to a file ("${target}") is not supported`);
    }
    await this.emit(text, out?.kind === 'stderr');
  }

  // --- the run ------------------------------------------------------------------------------

  async assign(assignment: string): Promise<void> {
    const eq = assignment.indexOf('=');
    const name = assignment.slice(0, eq);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new AwkError(`invalid variable name in ${assignment}`);
    this.setVar(name, strnum(unescape(assignment.slice(eq + 1))));
  }

  /** BEGIN, then every record of every input, then END; exit ends the input and, outside END, still runs END. */
  async run(inputs: AsyncIterable<{ name: string; text: string } | { assign: string }>): Promise<number> {
    const rules = this.program.rules;
    const begins = rules.filter((r) => r.pattern.k === 'begin');
    const ends = rules.filter((r) => r.pattern.k === 'end');
    const mains = rules.filter((r) => r.pattern.k !== 'begin' && r.pattern.k !== 'end');
    let exited = false;

    try {
      this.inBeginOrEnd = true;
      for (const r of begins) await this.execBlock(r.action!);
      this.inBeginOrEnd = false;
    } catch (signal) {
      if (!(signal instanceof ExitSignal)) throw signal;
      exited = true;
    }

    // With only BEGIN rules, awk does not read its input at all.
    if (!exited && (mains.length > 0 || ends.length > 0)) {
      try {
        outer: for await (const input of inputs) {
          if ('assign' in input) {
            await this.assign(input.assign);
            continue;
          }
          this.globals.set('FILENAME', input.name);
          this.globals.set('FNR', 0);
          for (const record of splitRecords(input.text, this.str(this.getVar('RS')))) {
            this.checkInterrupt();
            this.globals.set('NR', toNum(this.getVar('NR')) + 1);
            this.globals.set('FNR', toNum(this.getVar('FNR')) + 1);
            this.setRecord(record);
            try {
              for (const r of mains) {
                if (await this.matches(r.pattern)) {
                  if (r.action) await this.execBlock(r.action);
                  else await this.emit(this.record + this.str(this.getVar('ORS')));
                }
              }
            } catch (signal) {
              if (signal instanceof NextSignal) continue;
              if (signal instanceof NextFileSignal) continue outer;
              throw signal;
            }
          }
        }
      } catch (signal) {
        if (!(signal instanceof ExitSignal)) throw signal;
      }
    }

    try {
      this.inBeginOrEnd = true;
      for (const r of ends) await this.execBlock(r.action!);
    } catch (signal) {
      if (!(signal instanceof ExitSignal)) throw signal;
    }
    await this.flush();
    return this.exitCode;
  }

  private async matches(p: Pattern): Promise<boolean> {
    switch (p.k) {
      case 'all':
        return true;
      case 'expr':
        return truthy(await this.eval(p.expr));
      case 'range':
        if (!p.active) {
          if (!truthy(await this.eval(p.from))) return false;
          p.active = !truthy(await this.eval(p.to));
          return true;
        }
        if (truthy(await this.eval(p.to))) p.active = false;
        return true;
      default:
        return false;
    }
  }
}

const arith = (op: string, a: number, b: number): number => {
  switch (op) {
    case '+':
      return a + b;
    case '-':
      return a - b;
    case '*':
      return a * b;
    case '/':
      if (b === 0) throw new AwkError('division by zero');
      return a / b;
    case '%':
      if (b === 0) throw new AwkError('division by zero in %');
      return a % b;
    case '^':
      return a ** b;
  }
  throw new AwkError(`unknown operator ${op}`);
};

/** Numbers compare as numbers when both sides are numeric; otherwise as strings. */
const compare = (op: string, a: Value, b: Value, str: (v: Value) => string): boolean => {
  let c: number;
  if (isNumericValue(a) && isNumericValue(b)) {
    const x = toNum(a);
    const y = toNum(b);
    c = x < y ? -1 : x > y ? 1 : 0;
  } else {
    const x = str(a);
    const y = str(b);
    c = x < y ? -1 : x > y ? 1 : 0;
  }
  switch (op) {
    case '<':
      return c < 0;
    case '<=':
      return c <= 0;
    case '>':
      return c > 0;
    case '>=':
      return c >= 0;
    case '==':
      return c === 0;
    default:
      return c !== 0;
  }
};

const splitRegex = (text: string, re: RegExp): string[] => {
  if (text === '') return [];
  const parts: string[] = [];
  let last = 0;
  re.lastIndex = 0;
  for (let m = re.exec(text); m; m = re.exec(text)) {
    if (m[0] === '') {
      re.lastIndex++;
      continue;
    }
    parts.push(text.slice(last, m.index));
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return parts;
};

/** Fields by FS: " " for runs of blanks (and newlines), "" for each character, one character literally, else a regex. */
function splitWith(text: string, fs: string, paragraph: boolean): string[] {
  if (fs === ' ') {
    const trimmed = text.replace(/^[ \t\n]+|[ \t\n]+$/g, '');
    return trimmed === '' ? [] : trimmed.split(/[ \t\n]+/);
  }
  if (text === '') return [];
  if (fs === '') return [...text];
  const parts = fs.length === 1 && fs !== '\\' ? text.split(fs) : splitRegex(text, compileRegex(fs, true));
  // In paragraph mode a newline separates fields whatever FS is.
  return paragraph ? parts.flatMap((p) => p.split('\n')) : parts;
}

/** Records by RS: newline, "" for paragraphs (blank lines between), one character, or a regex. */
function splitRecords(text: string, rs: string): string[] {
  if (text === '') return [];
  if (rs === '\n') {
    const lines = text.split('\n');
    if (lines[lines.length - 1] === '') lines.pop();
    return lines;
  }
  if (rs === '') {
    const trimmed = text.replace(/^\n+|\n+$/g, '');
    return trimmed === '' ? [] : trimmed.split(/\n\n+/);
  }
  const records = rs.length === 1 ? text.split(rs) : splitRegex(text, compileRegex(rs, true));
  if (records[records.length - 1] === '' || records[records.length - 1] === '\n') records.pop();
  return records;
}

/** sub and gsub: `&` is the match, `\&` a literal ampersand, `\\` a backslash. */
function substitute(text: string, re: RegExp, replacement: string, global: boolean): { result: string; count: number } {
  const expand = (match: string) => {
    let out = '';
    for (let i = 0; i < replacement.length; i++) {
      const c = replacement[i];
      if (c === '\\' && (replacement[i + 1] === '&' || replacement[i + 1] === '\\')) {
        out += replacement[++i];
      } else if (c === '&') out += match;
      else out += c;
    }
    return out;
  };
  let result = '';
  let count = 0;
  let pos = 0;
  re.lastIndex = 0;
  while (pos <= text.length) {
    re.lastIndex = pos;
    const m = re.exec(text);
    if (!m) break;
    result += text.slice(pos, m.index) + expand(m[0]);
    count++;
    if (m[0] === '') {
      // An empty match inserts before the next character and moves past it.
      if (m.index < text.length) result += text[m.index];
      pos = m.index + 1;
    } else pos = m.index + m[0].length;
    if (!global) break;
  }
  if (pos <= text.length) result += text.slice(pos);
  return { result, count };
}

/** -v and command-line assignments process escape sequences, as string literals do. */
const unescape = (s: string): string => s.replace(/\\([ntr\\"/abfv])/g, (_, e: string) => ESCAPES[e]);

// ---------------------------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------------------------

/** Compile an awk program; exported for the tests. */
const compileAwk = (source: string): Program => new Parser(tokenize(source)).parseProgram();

export const awk = async (cmd: Command): CmdReturn => {
  const args = [...cmd.args];
  const assignments: string[] = [];
  const progFiles: string[] = [];
  let fs: string | undefined;
  let source: string | undefined;

  // Options come first; the first other argument is the program unless -f gave one.
  while (args.length > 0) {
    const a = args[0];
    if (a === '--') {
      args.shift();
      break;
    }
    if (!a.startsWith('-') || a === '-') break;
    args.shift();
    const flag = a[1];
    const inline = a.slice(2);
    const value = () => {
      if (inline) return inline;
      if (args.length === 0) throw new AwkError(`option -${flag} needs a value`);
      return args.shift()!;
    };
    try {
      if (flag === 'F') fs = value();
      else if (flag === 'v') assignments.push(value());
      else if (flag === 'f') progFiles.push(value());
      else {
        await cmd.writeError(`awk: unknown option ${a}\n`);
        return 2;
      }
    } catch (error) {
      await cmd.writeError(`awk: ${(error as Error).message}\n`);
      return 2;
    }
  }

  if (progFiles.length > 0) {
    source = '';
    for (const path of progFiles) {
      try {
        source += (await readOperand(cmd, path)) + '\n';
      } catch (error) {
        await cmd.writeError(`awk: ${path}: ${(error as Error).message}\n`);
        return 2;
      }
    }
    if (cmd.interrupted) return signalExitCode(cmd.signal ?? 'SIGINT');
  } else {
    if (args.length === 0) {
      await cmd.writeError('awk: no program given\n');
      return 2;
    }
    source = args.shift()!;
  }

  let program: Program;
  try {
    program = compileAwk(source);
  } catch (error) {
    await cmd.writeError(`awk: ${(error as Error).message}\n`);
    return 2;
  }

  const interpreter = new Interpreter(program, {
    write: (text) => cmd.write(text),
    writeError: (text) => cmd.writeError(text),
    interrupted: () => cmd.interrupted,
  });

  try {
    if (fs !== undefined) interpreter.globals.set('FS', fs === 't' ? '\t' : unescape(fs));
    for (const a of assignments) {
      if (!a.includes('=')) throw new AwkError(`-v needs var=value, got ${a}`);
      await interpreter.assign(a);
    }
    const envArray: AwkArray = new Map();
    for (const [key, value] of Object.entries(cmd.env)) envArray.set(key, strnum(value));
    interpreter.globals.set('ENVIRON', envArray);
  } catch (error) {
    await cmd.writeError(`awk: ${(error as Error).message}\n`);
    return 2;
  }

  // The operands: files, `-` for stdin, and var=value assignments made before the next file.
  const operands = args;
  const hasFiles = operands.some((o) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(o));
  // A terminating signal ends the input: the text read before it is not a whole record stream.
  const read = async (name: string, operand: string) => {
    const text = await readOperand(cmd, operand);
    if (cmd.interrupted) throw new AwkError('interrupted');
    return { name, text };
  };
  async function* inputs(): AsyncIterable<{ name: string; text: string } | { assign: string }> {
    if (!hasFiles) {
      for (const o of operands) yield { assign: o };
      yield await read('', '-');
      return;
    }
    for (const o of operands) {
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(o)) yield { assign: o };
      else {
        try {
          yield await read(o, o);
        } catch (error) {
          if (error instanceof AwkError) throw error;
          throw new AwkError(`${o}: ${(error as Error).message}`);
        }
      }
    }
  }

  try {
    return await interpreter.run(inputs());
  } catch (error) {
    if (cmd.interrupted) return signalExitCode(cmd.signal ?? 'SIGINT');
    await interpreter.flush().catch(() => {});
    await cmd.writeError(`awk: ${(error as Error).message}\n`);
    return 2;
  }
};

awk.spec = {
  name: 'awk',
  effect: 'read' as const,
  json: false,
  description: 'Pattern scanning and text processing language (fields, patterns, arrays, printf)',
  args: [
    {
      name: 'PROGRAM',
      type: 'string' as const,
      description: "awk program, e.g. '{ print $1 }' or 'BEGIN { FS=\":\" } $3 > 10 { n++ } END { print n }'; omit when using -f",
    },
    {
      name: 'FILE',
      type: 'path' as const,
      description: 'files to process, or var=value assignments (reads stdin if no files)',
      variadic: true,
    },
  ],
  flags: [
    { name: 'F', type: 'string' as const, description: 'field separator (a character, "t" for tab, or a regex)' },
    { name: 'v', type: 'string' as const, description: 'assign var=value before the program starts (repeatable)' },
    { name: 'f', type: 'string' as const, description: 'read the program from this file (repeatable)' },
  ],
};
