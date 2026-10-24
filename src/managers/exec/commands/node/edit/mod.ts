/**
 * `edit`: a text file in a terminal editor, highlighted, and checked as it is typed when it is
 * JSON, YAML, bash or Markdown. This file reads and writes the file and owns the terminal; the
 * editor itself is `editor.ts`.
 */

import { basename, dirname, resolve } from '@std/path';
import { toArrayBuffer } from '@std/streams/to-array-buffer';
import { getMimeFromExt, getMimeFromShebang, getMimeFromTextHeuristic, isTextMimetype, isUntypedMimetype } from '../../../../../lib/media/mime.ts';
import { NodeNotFoundError } from '../../../../../vfs/errors.ts';
import { type FileAttrs, NODE_TYPE_FILE } from '../../../../../vfs/types/file.ts';
import { languageFor } from '../../../../shell/terminal/syntax.ts';
import type { Command } from '../../../command.ts';
import type { CmdReturn } from '../../../types.ts';
import { Editor } from './editor.ts';

/** A file's text as the editor holds it — `\n` line ends, no final one — and how to write it back. */
type Decoded = { text: string; crlf: boolean; finalNewline: boolean };

type Loaded = Decoded & { mimetype?: string; isNew: boolean };

/** A file's bytes as text for the editor; refuses what is not UTF-8. */
export function decodeText(bytes: Uint8Array): Decoded {
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error('not UTF-8 text');
  }
  const crlf = text.includes('\r\n');
  if (crlf) text = text.replaceAll('\r\n', '\n');
  const finalNewline = text === '' || text.endsWith('\n');
  if (text.endsWith('\n')) text = text.slice(0, -1);
  return { text, crlf, finalNewline };
}

/** The editor's text as the file's bytes, with the line ends the file had. An empty text stays empty. */
export function encodeText(text: string, like: Omit<Decoded, 'text'>): Uint8Array {
  let content = text && like.finalNewline ? text + '\n' : text;
  if (like.crlf) content = content.replaceAll('\n', '\r\n');
  return new TextEncoder().encode(content);
}

async function load(cmd: Command, path: string): Promise<Loaded> {
  let attrs: FileAttrs;
  try {
    const node = await cmd.sys.vfs.get(cmd.access, path);
    if (node.type !== NODE_TYPE_FILE) throw new Error(`not a file (${node.type})`);
    attrs = node.attrs as FileAttrs;
  } catch (error) {
    if (error instanceof NodeNotFoundError) return { text: '', isNew: true, crlf: false, finalNewline: true };
    throw error;
  }
  const mimetype = attrs.mimetype ?? '';
  let bytes = new Uint8Array();
  try {
    const handle = await cmd.sys.vfs.open(cmd.access, path, { mode: 'r' });
    try {
      bytes = new Uint8Array(await toArrayBuffer(handle.readable));
    } finally {
      await handle.close();
    }
  } catch (error) {
    // A file node whose content is not stored yet opens empty.
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  }
  const isText = isTextMimetype(mimetype) || (isUntypedMimetype(mimetype) && (bytes.length === 0 || getMimeFromTextHeuristic(bytes) !== undefined));
  if (!isText) throw new Error(`not a text file (mimetype: ${mimetype})`);
  return { ...decodeText(bytes), mimetype, isNew: false };
}

/** Writes the text back with the line ends the file had; a new file is created, typed by its name or shebang. */
async function save(cmd: Command, path: string, file: Loaded, text: string): Promise<void> {
  const bytes = encodeText(text, file);
  if (file.isNew) {
    const name = basename(path);
    let mimetype = await getMimeFromExt(name, 'text/plain');
    if (mimetype === 'text/plain' && text.startsWith('#!')) mimetype = getMimeFromShebang(text.split('\n', 1)[0]);
    const attrs: FileAttrs = { name, mimetype, size: bytes.length };
    await cmd.sys.vfs.create(cmd.access, NODE_TYPE_FILE, dirname(path), name, { attrs });
    file.isNew = false;
  }
  const handle = await cmd.sys.vfs.open(cmd.access, path, { mode: 'w' });
  try {
    await handle.write(bytes);
  } finally {
    await handle.close();
  }
}

export const edit = async (cmd: Command): CmdReturn => {
  const pathArg = cmd.args[0];
  if (!pathArg) {
    await cmd.writeError('edit: missing file operand\n');
    return 1;
  }
  if (!cmd.tty) {
    await cmd.writeError('edit: not a terminal\n');
    return 1;
  }
  const path = resolve(cmd.cwd, pathArg);

  let file: Loaded;
  try {
    file = await load(cmd, path);
  } catch (error) {
    await cmd.writeError(`edit: ${path}: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }

  const editor = new Editor({
    text: file.text,
    name: basename(path),
    language: (firstLine) => languageFor({ name: path, mimetype: file.mimetype, firstLine }),
    isNew: file.isNew,
    rows: cmd.rows,
    cols: cmd.cols,
    save: (text) => save(cmd, path, file, text),
    write: (data) => cmd.write(data),
  });

  cmd.setRawMode(true);
  cmd.onResize((rows, cols) => {
    editor.resize(rows, cols).catch(() => {});
  });
  // The alternate screen gives the shell its screen back on exit; bracketed paste marks pasted text.
  await cmd.write('\x1b[?1049h\x1b[?2004h');
  try {
    await editor.start();
    // A kill from elsewhere ends the editor without saving; Ctrl-C in raw mode is only a key.
    for await (const keys of cmd.stdin.chunks()) {
      if (await editor.feed(keys)) break;
    }
  } finally {
    editor.close();
    cmd.onResize(null);
    cmd.setRawMode(false);
    await cmd.write('\x1b[?2004l\x1b[0m\x1b[?1049l');
  }
  return cmd.interrupted ? 130 : 0;
};

edit.spec = {
  name: 'edit',
  effect: 'write' as const,
  json: false,
  description: 'Edit a text file, with syntax highlighting and checks for JSON, YAML, bash and Markdown',
  args: [
    {
      name: 'path',
      type: 'path' as const,
      description: 'path to file to edit',
    },
  ],
  flags: [],
};
