/**
 * Syntax highlighting for the Web UI and the terminal alike. CodeMirror's lezer parsers, and its
 * legacy stream modes for the languages that have none, cut a text into tagged tokens; one
 * highlighter sorts the tags into the kinds both colour (`TokenKind`): the Web UI as
 * `mrx-tok-<kind>` classes, the terminal as ANSI colours. Nothing here touches the DOM, so core's
 * commands run it as the browser does.
 *
 * A Markdown text's fenced code blocks are parsed in the language their fence names, inside it.
 */
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { xml } from '@codemirror/lang-xml';
import { yaml } from '@codemirror/lang-yaml';
import { type Language, StreamLanguage, type StreamParser } from '@codemirror/language';
import { sCSS } from '@codemirror/legacy-modes/mode/css';
import { diff } from '@codemirror/legacy-modes/mode/diff';
import { go } from '@codemirror/legacy-modes/mode/go';
import { json as jsonWithComments } from '@codemirror/legacy-modes/mode/javascript';
import { lua } from '@codemirror/legacy-modes/mode/lua';
import { properties } from '@codemirror/legacy-modes/mode/properties';
import { python } from '@codemirror/legacy-modes/mode/python';
import { rust } from '@codemirror/legacy-modes/mode/rust';
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { standardSQL } from '@codemirror/legacy-modes/mode/sql';
import { toml } from '@codemirror/legacy-modes/mode/toml';
import { highlightTree, tagHighlighter, tags } from '@lezer/highlight';

/** What a token is, as both surfaces colour it. */
export type TokenKind =
  | 'keyword'
  | 'command'
  | 'string'
  | 'comment'
  | 'number'
  | 'variable'
  | 'definition'
  | 'flag'
  | 'property'
  | 'type'
  | 'operator'
  | 'heading'
  | 'meta'
  | 'strong'
  | 'emphasis'
  | 'link'
  | 'code'
  | 'inserted'
  | 'deleted';

/** Tags to kinds; the class a token gets is the names of its kinds. */
const highlighter = tagHighlighter([
  { tag: tags.keyword, class: 'keyword' },
  { tag: tags.standard(tags.variableName), class: 'command' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], class: 'string' },
  { tag: tags.comment, class: 'comment' },
  { tag: [tags.number, tags.bool, tags.atom, tags.null], class: 'number' },
  { tag: tags.special(tags.variableName), class: 'variable' },
  { tag: [tags.definition(tags.variableName), tags.definition(tags.propertyName)], class: 'definition' },
  { tag: tags.attributeName, class: 'flag' },
  { tag: [tags.propertyName, tags.tagName], class: 'property' },
  { tag: [tags.typeName, tags.className], class: 'type' },
  { tag: tags.operator, class: 'operator' },
  { tag: tags.heading, class: 'heading' },
  // Markdown's marks (`#`, `**`, a fence and the language it names) are `processingInstruction` and `labelName`.
  { tag: [tags.meta, tags.punctuation, tags.processingInstruction, tags.labelName], class: 'meta' },
  { tag: tags.strong, class: 'strong' },
  { tag: tags.emphasis, class: 'emphasis' },
  { tag: [tags.link, tags.url], class: 'link' },
  { tag: tags.monospace, class: 'code' },
  { tag: tags.inserted, class: 'inserted' },
  { tag: tags.deleted, class: 'deleted' },
]);

type CommandLineState = { command: boolean };

/**
 * A EiN command line, as documentation shows one: the command, its flags, `KEY=value`
 * prefixes, quotes, variables and the operators that start the next command.
 *
 * Not the `bash` mode: that one colours a fixed list of Unix builtins and leaves `search` or
 * `album-stack` as plain words, and the command is the one word a reader of an example looks for
 * first.
 */
const commandLine: StreamParser<CommandLineState> = {
  name: 'command-line',
  startState: () => ({ command: true }),
  token(stream, state) {
    if (stream.sol()) state.command = true;
    if (stream.eatSpace()) return null;
    if (stream.match(/^#.*/)) return 'comment';
    // A placeholder in a synopsis, `<album>` or `[options]`, before `<` can be read as a redirect.
    if (stream.match(/^<[A-Za-z][\w-]*>…?/) || stream.match(/^\[[A-Za-z][\w-]*\]/)) {
      state.command = false;
      return 'meta';
    }
    if (stream.match(/^(\|\||&&|[|;&]|\$\(|\(|\)|`)/)) {
      state.command = true;
      return 'operator';
    }
    if (stream.match(/^\d*[<>]{1,2}&?\d*/)) return 'operator';
    if (state.command && stream.match(/^[A-Za-z_][A-Za-z0-9_]*=("[^"]*"?|'[^']*'?|[^\s|;&]*)/)) return 'def';
    if (stream.match(/^'[^']*'?/) || stream.match(/^"(?:[^"\\]|\\.)*"?/)) {
      state.command = false;
      return 'string';
    }
    if (stream.match(/^\$\{[^}]*\}?/) || stream.match(/^\$[A-Za-z_][A-Za-z0-9_]*/) || stream.match(/^\$[?#@*$!0-9]/)) {
      state.command = false;
      return 'variable-2';
    }
    if (!state.command && stream.match(/^--?[A-Za-z][\w-]*=?/)) return 'attribute';
    if (!state.command && stream.match(/^-?\d+(\.\d+)?(?=[\s|;&)]|$)/)) return 'number';
    if (stream.match(/^[^\s|;&<>()'"`$#]+/)) {
      if (!state.command) return null;
      state.command = false;
      return 'builtin';
    }
    stream.next();
    return null;
  },
};

type SessionState = { command: boolean; line: CommandLineState };

/** A shell session as a transcript shows it: a line after a `$ ` or `# ` prompt is a command line, any other is its output, left plain. */
const consoleSession: StreamParser<SessionState> = {
  name: 'console',
  startState: () => ({ command: false, line: { command: true } }),
  token(stream, state) {
    if (stream.sol()) {
      state.command = false;
      if (stream.match(/^[$#] /)) {
        state.command = true;
        state.line = { command: true };
        return 'meta';
      }
    }
    if (!state.command) {
      stream.skipToEnd();
      return null;
    }
    return commandLine.token(stream, state.line);
  },
};

const stream = (parser: StreamParser<unknown>) => () => StreamLanguage.define(parser);

/** Each language by its name here. */
const LANGUAGES: Record<string, () => Language> = {
  'command-line': stream(commandLine as StreamParser<unknown>),
  console: stream(consoleSession as StreamParser<unknown>),
  bash: stream(shell),
  json: () => json().language,
  // JSON with comments: the lezer grammar takes none. The legacy mode calls a key `property`.
  jsonc: stream({ ...jsonWithComments, tokenTable: { property: tags.propertyName } }),
  javascript: () => javascript({ jsx: true }).language,
  typescript: () => javascript({ jsx: true, typescript: true }).language,
  yaml: () => yaml().language,
  markdown: () => markdown({ codeLanguages: (info) => languageFor(info) ?? null }).language,
  html: () => html().language,
  css: () => css().language,
  scss: stream(sCSS),
  xml: () => xml().language,
  python: stream(python),
  sql: stream(standardSQL),
  go: stream(go),
  rust: stream(rust),
  lua: stream(lua),
  diff: stream(diff),
  ini: stream(properties),
  toml: stream(toml),
};

/** Other names for them, as fences and file types write them. */
const ALIASES: Record<string, string> = {
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  // No grammar of its own: comments, strings and variables are where bash has them.
  makefile: 'bash',
  json5: 'jsonc',
  js: 'javascript',
  jsx: 'javascript',
  mjs: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  yml: 'yaml',
  md: 'markdown',
  htm: 'html',
  svg: 'xml',
  py: 'python',
  golang: 'go',
  rs: 'rust',
  patch: 'diff',
  conf: 'ini',
  properties: 'ini',
};

const made = new Map<string, Language | undefined>();

/** The language a name means (`ts`, `yml`, `JSON`), made once; `undefined` for one it does not know. */
export function languageFor(name: string): Language | undefined {
  const lower = name.trim().toLowerCase();
  const key = ALIASES[lower] ?? lower;
  if (!made.has(key)) made.set(key, LANGUAGES[key]?.());
  return made.get(key);
}

/** A run of the text, with the kinds of token it is; none for text between tokens. */
type Range = { text: string; kinds?: TokenKind[] };

/** The text cut into runs by the named language's parser; one plain run for a language it does not know. */
export function highlightRanges(code: string, language: string): Range[] {
  const lang = languageFor(language);
  if (!lang) return [{ text: code }];
  const out: Range[] = [];
  let pos = 0;
  highlightTree(lang.parser.parse(code), highlighter, (from, to, classes) => {
    if (from > pos) out.push({ text: code.slice(pos, from) });
    out.push({ text: code.slice(from, to), kinds: classes.split(' ') as TokenKind[] });
    pos = to;
  });
  if (pos < code.length) out.push({ text: code.slice(pos) });
  return out;
}
