/**
 * Which language a text node is written in, for the code editor.
 *
 * The mimetype the file's own attributes carry decides first; it mirrors the
 * `cat` command's map plus `text/x-shellscript`, which is what the sniffer
 * reports for anything starting with `#!`. A file
 * whose mimetype says nothing — absent, `text/plain`, a generic octet stream —
 * falls back to its extension, since `deno.jsonc` and `README.md` are worth
 * colouring even when the sniffer had no better idea.
 */

export type CodeLanguage =
  | 'json'
  | 'javascript'
  | 'typescript'
  | 'yaml'
  | 'markdown'
  | 'html'
  | 'css'
  | 'xml'
  | 'shell'
  | 'text';

const MIME_TO_LANG: Record<string, CodeLanguage> = {
  'application/json': 'json',
  'application/javascript': 'javascript',
  'text/javascript': 'javascript',
  'application/typescript': 'typescript',
  'text/typescript': 'typescript',
  'text/html': 'html',
  'text/css': 'css',
  'text/markdown': 'markdown',
  'application/x-yaml': 'yaml',
  'text/yaml': 'yaml',
  'text/x-yaml': 'yaml',
  'text/xml': 'xml',
  'application/xml': 'xml',
  'text/x-sh': 'shell',
  'text/x-shellscript': 'shell',
  'application/x-sh': 'shell',
};

const EXT_TO_LANG: Record<string, CodeLanguage> = {
  json: 'json',
  jsonc: 'json',
  js: 'javascript',
  mjs: 'javascript',
  cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript',
  mts: 'typescript',
  tsx: 'typescript',
  yaml: 'yaml',
  yml: 'yaml',
  md: 'markdown',
  markdown: 'markdown',
  html: 'html',
  htm: 'html',
  css: 'css',
  xml: 'xml',
  svg: 'xml',
  sh: 'shell',
  bash: 'shell',
  txt: 'text',
  log: 'text',
  csv: 'text',
  env: 'text',
};

/** Mimetypes that say "bytes" or "some text", not what kind. */
const UNTYPED = new Set(['', 'text/plain', 'application/octet-stream']);

const extensionOf = (name?: string): string | undefined => {
  const dot = name?.lastIndexOf('.') ?? -1;
  return dot > 0 ? name!.slice(dot + 1).toLowerCase() : undefined;
};

const baseMime = (mimetype?: string): string => (mimetype ?? '').split(';')[0].trim().toLowerCase();

/** The editor language for a node, `text` when nothing better is known. */
export function languageFor(mimetype?: string, name?: string): CodeLanguage {
  const mime = baseMime(mimetype);
  const byMime = MIME_TO_LANG[mime];
  if (byMime) return byMime;
  const ext = extensionOf(name);
  const byExt = ext ? EXT_TO_LANG[ext] : undefined;
  if (byExt) return byExt;
  return 'text';
}

/**
 * Whether a file node is something the editor should open: text by mimetype,
 * or an untyped file with a text-looking name. A PDF is `application/pdf` and
 * a picture `image/*`, so neither qualifies; those keep their own viewers.
 */
export function isTextLike(mimetype?: string, name?: string): boolean {
  const mime = baseMime(mimetype);
  if (mime.startsWith('text/')) return true;
  if (MIME_TO_LANG[mime]) return true;
  if (!UNTYPED.has(mime)) return false;
  const ext = extensionOf(name);
  return ext !== undefined && EXT_TO_LANG[ext] !== undefined;
}
