import { resolve } from '@std/path';
import { parseArgs } from '../../../../lib/args/mod.ts';
import { getMimeFromBuffer, getMimeFromExt, isRawExtension, isRawMimetype, MIME_SAMPLE_BYTES } from '../../../../lib/media/mod.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

export const mime = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, {});

  if (!flags._[0]) {
    await cmd.writeError('mime: path required\n');
    await cmd.writeError('Usage: mime <path>\n');
    return 1;
  }

  const path = resolve(cmd.cwd, flags._[0] as string);

  try {
    const node = await cmd.sys.vfs.get(cmd.access, path);
    const stored = (node.attrs as { mimetype?: string }).mimetype ?? null;
    const fromExt = await getMimeFromExt(path);

    let fromContent: string | null = null;
    try {
      const handle = await cmd.sys.vfs.open(cmd.access, path, { mode: 'r' });
      try {
        const bytes = await handle.read(MIME_SAMPLE_BYTES);
        fromContent = bytes.length > 0 ? await getMimeFromBuffer(bytes) : null;
      } finally {
        await handle.close();
      }
    } catch {
      // Not readable as a file, a directory say.
    }

    const raw = isRawMimetype(stored) || isRawMimetype(fromExt) || isRawExtension(path);

    const result = { path, stored, ext: fromExt, content: fromContent, raw };

    if (cmd.json) {
      await cmd.writeJSON(result);
    } else {
      await cmd.writeLn(`stored:  ${stored ?? '-'}`);
      await cmd.writeLn(`ext:     ${fromExt}`);
      await cmd.writeLn(`content: ${fromContent ?? '-'}`);
      await cmd.writeLn(`raw:     ${raw ? 'yes' : 'no'}`);
    }
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`mime: ${path}: ${message}\n`);
    return 1;
  }
};

mime.spec = {
  name: 'mime',
  effect: 'read' as const,
  description: 'Show stored, extension-based and content-sniffed mimetype of a node',
  args: [
    {
      name: 'path',
      type: 'path' as const,
      description: 'path to node',
    },
  ],
  flags: [],
};
