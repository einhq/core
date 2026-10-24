import { type Language, LanguageSupport, StreamLanguage, type StreamParser } from '@codemirror/language';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { xml } from '@codemirror/lang-xml';
import { yaml } from '@codemirror/lang-yaml';
import { highlightTree, tagHighlighter, tags } from '@lezer/highlight';
import { type ReactNode, useMemo } from 'react';

type CommandLineState = { command: boolean };

/**
 * A EiN command line, as documentation shows one: the command, its flags, `KEY=value`
 * prefixes, quotes, variables and the operators that start the next command.
 *
 * Not the legacy `shell` mode the editor uses: that one colours a fixed list of Unix builtins
 * and leaves `search` or `album-stack` as plain words, and the command is the one word a reader
 * of an example looks for first.
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

/** Tags to the `mrx-tok-*` classes `theme.css` colours for both schemes. */
const highlighter = tagHighlighter([
  { tag: tags.keyword, class: 'mrx-tok-keyword' },
  { tag: tags.standard(tags.variableName), class: 'mrx-tok-command' },
  { tag: [tags.string, tags.special(tags.string), tags.regexp], class: 'mrx-tok-string' },
  { tag: tags.comment, class: 'mrx-tok-comment' },
  { tag: [tags.number, tags.bool, tags.atom, tags.null], class: 'mrx-tok-number' },
  { tag: tags.special(tags.variableName), class: 'mrx-tok-variable' },
  { tag: [tags.definition(tags.variableName), tags.definition(tags.propertyName)], class: 'mrx-tok-definition' },
  { tag: tags.attributeName, class: 'mrx-tok-flag' },
  { tag: [tags.propertyName, tags.tagName], class: 'mrx-tok-property' },
  { tag: [tags.typeName, tags.className], class: 'mrx-tok-type' },
  { tag: tags.operator, class: 'mrx-tok-operator' },
  { tag: tags.heading, class: 'mrx-tok-heading' },
  { tag: [tags.meta, tags.punctuation], class: 'mrx-tok-meta' },
]);

/** The fence names a document may use, to the parser for each. `console`, `sh` and no name at all are command lines. */
const PARSERS: Record<string, () => Language> = {
  shell: () => StreamLanguage.define(commandLine),
  json: () => json().language,
  javascript: () => javascript({ jsx: true }).language,
  typescript: () => javascript({ jsx: true, typescript: true }).language,
  yaml: () => yaml().language,
  markdown: () => markdown().language,
  html: () => html().language,
  css: () => css().language,
  xml: () => xml().language,
};

const ALIASES: Record<string, string> = {
  '': 'shell',
  sh: 'shell',
  bash: 'shell',
  console: 'shell',
  js: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  tsx: 'typescript',
  jsonc: 'json',
  yml: 'yaml',
  md: 'markdown',
};

const languages = new Map<string, Language | null>();

const languageFor = (name: string): Language | null => {
  const key = ALIASES[name.toLowerCase()] ?? name.toLowerCase();
  if (!languages.has(key)) {
    const made = PARSERS[key]?.();
    languages.set(key, made instanceof LanguageSupport ? made.language : made ?? null);
  }
  return languages.get(key)!;
};

/** The text cut into runs, each with the classes the language's parser gave it, if any. Pure, so it is tested directly. */
export const highlightRanges = (code: string, language: string): { text: string; className?: string }[] => {
  const lang = languageFor(language);
  if (!lang) return [{ text: code }];
  const out: { text: string; className?: string }[] = [];
  let pos = 0;
  highlightTree(lang.parser.parse(code), highlighter, (from, to, classes) => {
    if (from > pos) out.push({ text: code.slice(pos, from) });
    out.push({ text: code.slice(from, to), className: classes });
    pos = to;
  });
  if (pos < code.length) out.push({ text: code.slice(pos) });
  return out;
};

const highlight = (code: string, language: string): ReactNode[] =>
  highlightRanges(code, language).map((range, i) => range.className ? <span key={i} className={range.className}>{range.text}</span> : range.text);

export type HighlightedCodeProps = {
  code: string;
  /** A fence name (`sh`, `json`, `yaml`…). None is a command line; a name it does not know is plain text. */
  language?: string;
  /** Inline in running text rather than a block of its own. */
  inline?: boolean;
};

/**
 * Code coloured the way the editor colours it, without an editor: the language's parser run
 * once and the result drawn as spans. A page of three hundred command examples cannot afford
 * an `EditorView` apiece.
 */
export function HighlightedCode({ code, language = '', inline = false }: HighlightedCodeProps) {
  const spans = useMemo(() => highlight(code, language), [code, language]);
  if (inline) return <code className='mrx-code mrx-code-inline'>{spans}</code>;
  return (
    <pre className='mrx-code mrx-code-block'>
      <code>{spans}</code>
    </pre>
  );
}
