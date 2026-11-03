/**
 * Syntax highlighting for the terminal: which language a file is written in, and its text as
 * styled runs, one list per line.
 *
 * The text is highlighted as the Web UI highlights it (`@ein/highlight`), parsed whole, so a
 * string, comment or here-document that spans lines keeps its style on each of them, and a
 * Markdown text's fenced blocks are coloured in the language their fence names. Each kind of
 * token is drawn in one of the 16 ANSI colors, as SGR parameters, so it follows the terminal's own
 * theme.
 */

import { basename, extname } from '@std/path';
import { highlightRanges, type TokenKind } from '../../../lib/highlight/mod.ts';
import { getMimeFromShebang, isUntypedMimetype } from '../../../lib/media/mime.ts';

/** A stretch of one line drawn in one style; `style` is SGR parameters, `''` for plain text. */
export type Run = { text: string; style: string };
export type StyledLine = Run[];

/** Texts longer than this are drawn plain: the editor highlights the whole text after every change. */
const MAX_HIGHLIGHT_LENGTH = 256 * 1024;

const EXT_TO_LANG: Record<string, string> = {
  json: 'json',
  jsonc: 'jsonc',
  yaml: 'yaml',
  yml: 'yaml',
  sh: 'bash',
  bash: 'bash',
  md: 'markdown',
  markdown: 'markdown',
  ts: 'typescript',
  mts: 'typescript',
  tsx: 'typescript',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  py: 'python',
  html: 'html',
  htm: 'html',
  xml: 'xml',
  svg: 'xml',
  css: 'css',
  scss: 'scss',
  ini: 'ini',
  conf: 'ini',
  toml: 'toml',
  sql: 'sql',
  diff: 'diff',
  patch: 'diff',
  go: 'go',
  rs: 'rust',
  lua: 'lua',
};

const MIME_TO_LANG: Record<string, string> = {
  'application/json': 'json',
  'application/javascript': 'javascript',
  'text/javascript': 'javascript',
  'application/typescript': 'typescript',
  'text/typescript': 'typescript',
  'text/html': 'html',
  'text/css': 'css',
  'text/markdown': 'markdown',
  'text/x-python': 'python',
  'application/x-yaml': 'yaml',
  'application/yaml': 'yaml',
  'text/yaml': 'yaml',
  'text/x-yaml': 'yaml',
  'text/xml': 'xml',
  'application/xml': 'xml',
  'text/x-sh': 'bash',
  'text/x-shellscript': 'bash',
  'application/x-sh': 'bash',
};

/**
 * The language of a file: its extension decides first (a `.ts` file can be sniffed as an MPEG
 * transport stream), then its mimetype, then a shebang on its first line. `undefined` is plain text.
 */
export function languageFor(file: { name?: string; mimetype?: string; firstLine?: string }): string | undefined {
  const name = file.name ? basename(file.name) : '';
  const ext = extname(name).slice(1).toLowerCase();
  if (ext && EXT_TO_LANG[ext]) return EXT_TO_LANG[ext];
  if (/^(GNU)?makefile$/i.test(name) || ext === 'mk') return 'makefile';
  const mime = (file.mimetype ?? '').split(';')[0].trim().toLowerCase();
  if (MIME_TO_LANG[mime]) return MIME_TO_LANG[mime];
  if (file.firstLine?.startsWith('#!') && isUntypedMimetype(mime)) {
    return MIME_TO_LANG[getMimeFromShebang(file.firstLine)];
  }
  return undefined;
}

/** What each kind of token is drawn as; `''` is plain. */
const STYLES: Record<TokenKind, string> = {
  keyword: '35',
  command: '35',
  string: '32',
  comment: '90',
  number: '33',
  variable: '36',
  definition: '34',
  flag: '34',
  property: '34',
  type: '33',
  operator: '',
  heading: '1;34',
  meta: '90',
  strong: '1',
  emphasis: '3',
  link: '4;36',
  code: '33',
  inserted: '32',
  deleted: '31',
};

/** A token's style: that of the last of its kinds that has one, the innermost (a key of JSON is a string and a property). */
const styleOf = (kinds: TokenKind[] | undefined): string => {
  const kind = kinds?.findLast((kind) => STYLES[kind]);
  return kind ? STYLES[kind] : '';
};

const plainLines = (text: string): StyledLine[] => text.split('\n').map((line) => (line ? [{ text: line, style: '' }] : []));

/** A text as styled lines in a language; no language, one it does not know, or a very long text is plain. */
export function highlightLines(text: string, lang?: string): StyledLine[] {
  if (!lang || text.length > MAX_HIGHLIGHT_LENGTH) return plainLines(text);
  const lines: StyledLine[] = [[]];
  for (const range of highlightRanges(text, lang)) {
    const style = styleOf(range.kinds);
    range.text.split('\n').forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (!part) return;
      const line = lines[lines.length - 1];
      const last = line[line.length - 1];
      if (last && last.style === style) last.text += part;
      else line.push({ text: part, style });
    });
  }
  return lines;
}

/** Styled lines as text with ANSI escapes, each run closed so the text can be cut at any line. */
export function toAnsi(lines: StyledLine[]): string {
  return lines.map((line) => line.map((run) => (run.style ? `\x1b[${run.style}m${run.text}\x1b[0m` : run.text)).join('')).join('\n');
}
