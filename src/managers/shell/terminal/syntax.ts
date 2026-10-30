/**
 * Syntax highlighting for the terminal: which language a file is written in, and its text as
 * styled runs, one list per line.
 *
 * lowlight tokenizes the whole text with highlight.js's common grammars, so a string, comment or
 * here-document that spans lines keeps its style on each of them. Styles are SGR parameters for
 * the 16 ANSI colors, so they follow the terminal's own theme. Markdown is split into prose and
 * fenced code blocks first; a block is highlighted in the language its fence names.
 */

import { basename, extname } from '@std/path';
import { common, createLowlight } from 'lowlight';
import { getMimeFromShebang, isUntypedMimetype } from '../../../lib/media/mime.ts';

const lowlight = createLowlight(common);

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
  html: 'xml',
  htm: 'xml',
  xml: 'xml',
  svg: 'xml',
  css: 'css',
  scss: 'scss',
  ini: 'ini',
  conf: 'ini',
  toml: 'ini',
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
  'text/html': 'xml',
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

/** Fence and alias names that mean one of the languages this module has its own handling for. */
const ALIASES: Record<string, string> = {
  sh: 'bash',
  shell: 'bash',
  zsh: 'bash',
  yml: 'yaml',
  json5: 'jsonc',
  md: 'markdown',
  ts: 'typescript',
  js: 'javascript',
};

/** A language name as written on a fence or a flag (`sh`, `yml`, `JSON`), in this module's terms. */
function canonicalLanguage(name: string): string {
  const lower = name.toLowerCase();
  return ALIASES[lower] ?? lower;
}

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

/** What each highlight.js class is drawn as. A class not listed takes its parent's style. */
const STYLES: Record<string, string> = {
  comment: '90',
  meta: '90',
  doctag: '90',
  string: '32',
  regexp: '32',
  symbol: '32',
  number: '33',
  literal: '33',
  keyword: '35',
  built_in: '35',
  'selector-tag': '35',
  type: '33',
  title: '33',
  variable: '36',
  'template-variable': '36',
  subst: '36',
  attr: '34',
  attribute: '34',
  property: '34',
  name: '34',
  tag: '34',
  'selector-class': '34',
  'selector-id': '34',
  addition: '32',
  deletion: '31',
  section: '1;34',
  strong: '1',
  emphasis: '3',
  code: '33',
  link: '4;36',
  bullet: '35',
  quote: '35',
};

/** Markdown's link text comes as `string`; it is drawn as the link it is. */
const MARKDOWN_STYLES: Record<string, string> = { ...STYLES, string: '4;36' };

/** Classes whose style holds for everything inside them: JSON's `true` is a keyword inside a literal. */
const STICKY = new Set(['literal']);

type HastNode = { type: string; value?: string; properties?: { className?: unknown }; children?: HastNode[] };

/** The text of a lowlight tree as styled runs, split at newlines. */
function treeToLines(root: HastNode, styles: Record<string, string>): StyledLine[] {
  const lines: StyledLine[] = [[]];
  const push = (text: string, style: string) => {
    const parts = text.split('\n');
    parts.forEach((part, i) => {
      if (i > 0) lines.push([]);
      if (!part) return;
      const line = lines[lines.length - 1];
      const last = line[line.length - 1];
      if (last && last.style === style) last.text += part;
      else line.push({ text: part, style });
    });
  };
  const walk = (node: HastNode, style: string, sticky: boolean) => {
    if (node.type === 'text') {
      push(node.value ?? '', style);
      return;
    }
    let own = style;
    let holds = sticky;
    if (!sticky && Array.isArray(node.properties?.className)) {
      const name = (node.properties.className as string[]).find((c) => c.startsWith('hljs-'))?.slice(5);
      if (name && styles[name] !== undefined) {
        own = styles[name];
        holds = STICKY.has(name);
      }
    }
    for (const child of node.children ?? []) walk(child, own, holds);
  };
  walk(root, '', false);
  return lines;
}

const plainLines = (text: string): StyledLine[] => text.split('\n').map((line) => (line ? [{ text: line, style: '' }] : []));

/** One grammar over one text; a language lowlight does not know is plain text. */
function highlightGrammar(text: string, lang: string, styles: Record<string, string> = STYLES): StyledLine[] {
  const grammar = lang === 'jsonc' ? 'json' : lang;
  if (!lowlight.registered(grammar)) return plainLines(text);
  return treeToLines(lowlight.highlight(grammar, text) as HastNode, styles);
}

/** A fenced code block in Markdown, by line index: the fence, the first body line, and the line after the body. */
type FencedBlock = {
  /** The language the fence names, in `canonicalLanguage` terms; `''` when it names none. */
  lang: string;
  fence: number;
  body: number;
  /** The closing fence's line, or the number of lines when the block runs to the end. */
  end: number;
};

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})\s*([^\s`{]*)/;

/** The fenced code blocks of a Markdown text, given as its lines. An unclosed fence runs to the end. */
export function fencedBlocks(lines: string[]): FencedBlock[] {
  const blocks: FencedBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = FENCE_OPEN.exec(lines[i]);
    if (!open) continue;
    const marker = open[1];
    const close = new RegExp(`^ {0,3}${marker[0] === '`' ? '`' : '~'}{${marker.length},}\\s*$`);
    let end = i + 1;
    while (end < lines.length && !close.test(lines[end])) end++;
    blocks.push({ lang: open[2] ? canonicalLanguage(open[2]) : '', fence: i, body: i + 1, end });
    i = end;
  }
  return blocks;
}

const FENCE_STYLE = STYLES.comment;
const UNNAMED_CODE_STYLE = STYLES.code;

function highlightMarkdown(text: string): StyledLine[] {
  const lines = text.split('\n');
  let out: StyledLine[] = [];
  let prose = 0;
  const flushProse = (until: number) => {
    if (until > prose) out = out.concat(highlightGrammar(lines.slice(prose, until).join('\n'), 'markdown', MARKDOWN_STYLES));
  };
  for (const block of fencedBlocks(lines)) {
    flushProse(block.fence);
    out.push([{ text: lines[block.fence], style: FENCE_STYLE }]);
    if (block.end > block.body) {
      const body = lines.slice(block.body, block.end).join('\n');
      const grammar = block.lang === 'jsonc' ? 'json' : block.lang;
      out = out.concat(
        grammar && lowlight.registered(grammar) ? highlightGrammar(body, grammar) : body.split('\n').map((line) => (line ? [{ text: line, style: UNNAMED_CODE_STYLE }] : [])),
      );
    }
    if (block.end < lines.length) out.push([{ text: lines[block.end], style: FENCE_STYLE }]);
    prose = block.end + 1;
  }
  flushProse(lines.length);
  return out;
}

/** A text as styled lines in a language; no language, an unknown one, or a very long text is plain. */
export function highlightLines(text: string, lang?: string): StyledLine[] {
  if (!lang || text.length > MAX_HIGHLIGHT_LENGTH) return plainLines(text);
  if (lang === 'markdown') return highlightMarkdown(text);
  return highlightGrammar(text, lang);
}

/** Styled lines as text with ANSI escapes, each run closed so the text can be cut at any line. */
export function toAnsi(lines: StyledLine[]): string {
  return lines.map((line) => line.map((run) => (run.style ? `\x1b[${run.style}m${run.text}\x1b[0m` : run.text)).join('')).join('\n');
}
