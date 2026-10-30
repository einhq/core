import { basename, dirname, join } from '@std/path';
import { toText } from '@std/streams/to-text';
import { ADMIN_ACCESS, ADMIN_GID, ADMIN_GROUPNAME, ADMIN_UID } from '../../../../lib/access/mod.ts';
import { BASHRC_GROUPS_PATH, ETC_PATH } from '../../../../lib/paths.ts';
import { NodeNotFoundError } from '../../../../vfs/mod.ts';
import { NODE_TYPE_DIRECTORY } from '../../../../vfs/types/directory.ts';
import { type FileAttrs, NODE_TYPE_FILE } from '../../../../vfs/types/file.ts';
import type { Command } from '../../command.ts';

/**
 * The bashrc PATH line for a module's bin/ directory. Guarded with `case` so
 * re-sourcing bashrc onto an already-populated inherited PATH (child shells,
 * pipeline engine) does not append duplicates.
 */
export const buildPathExportLine = (binPath: string): string =>
  // The pattern is unquoted on purpose: the shell's case matcher treats quotes in
  // patterns literally (module bin paths contain no glob chars or spaces).
  `case ":$PATH:" in *:${binPath}:*) ;; *) export PATH="$PATH:${binPath}";; esac`;

const readText = async (cmd: Command, path: string): Promise<string | undefined> => {
  try {
    const handle = await cmd.sys.vfs.open(ADMIN_ACCESS, path, { mode: 'r' });
    try {
      return await toText(handle.readable);
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof NodeNotFoundError) return undefined;
    throw error;
  }
};

const writeText = async (cmd: Command, path: string, text: string): Promise<void> => {
  const handle = await cmd.sys.vfs.open(ADMIN_ACCESS, path, { mode: 'w' });
  try {
    await handle.write(new TextEncoder().encode(text));
  } finally {
    await handle.close();
  }
};

/** The group setup files there are, by path. */
const groupRcFiles = async (cmd: Command): Promise<string[]> => {
  try {
    return (await cmd.sys.vfs.children(ADMIN_ACCESS, BASHRC_GROUPS_PATH)).map((child) => join(BASHRC_GROUPS_PATH, child.name));
  } catch (error) {
    if (error instanceof NodeNotFoundError) return [];
    throw error;
  }
};

/** Add `line` to the end of the file at `path` unless it has it, creating the file, the administrator's and readable by all. */
const addLine = async (cmd: Command, path: string, line: string): Promise<boolean> => {
  const text = await readText(cmd, path);
  if (text?.split('\n').includes(line)) return false;
  if (text === undefined) {
    if (dirname(path) === BASHRC_GROUPS_PATH) {
      await cmd.sys.vfs.ensure(ADMIN_ACCESS, NODE_TYPE_DIRECTORY, dirname(BASHRC_GROUPS_PATH), basename(BASHRC_GROUPS_PATH), {
        props: { uid: ADMIN_UID, gid: ADMIN_GID, mode: 0o755 },
      });
    }
    const name = basename(path);
    const attrs: FileAttrs = { name, mimetype: 'text/plain', size: 0 };
    await cmd.sys.vfs.ensure<FileAttrs>(ADMIN_ACCESS, NODE_TYPE_FILE, dirname(path), name, { props: { uid: ADMIN_UID, gid: ADMIN_GID, mode: 0o644, tier: 'db' }, attrs });
  }
  const before = text ?? '';
  await writeText(cmd, path, `${before}${before && !before.endsWith('\n') ? '\n' : ''}${line}\n`);
  return true;
};

/** Take `line` out of the file at `path`; a group's file left with nothing in it goes. */
const removeLine = async (cmd: Command, path: string, line: string): Promise<boolean> => {
  const text = await readText(cmd, path);
  if (text === undefined || !text.split('\n').includes(line)) return false;
  const kept = text.split('\n').filter((row) => row !== line).join('\n');
  if (path.startsWith(`${BASHRC_GROUPS_PATH}/`) && kept.trim() === '') await cmd.sys.vfs.unlink(ADMIN_ACCESS, path, BASHRC_GROUPS_PATH);
  else await writeText(cmd, path, kept);
  return true;
};

/**
 * Put a module's PATH line where its users' shells read it: in `/etc/bashrc` for a module that is
 * everyone's, else in `/etc/bashrc.d/<group>` for each of `groups` and for the administrators, and
 * nowhere else.
 */
export const placePathLine = async (cmd: Command, binPath: string, groups: string[]): Promise<void> => {
  const line = buildPathExportLine(binPath);
  const bashrc = join(cmd.env.ETC_PATH || ETC_PATH, 'bashrc');
  const wanted = groups.length === 0 ? [bashrc] : [...new Set([...groups, ADMIN_GROUPNAME])].map((group) => join(BASHRC_GROUPS_PATH, group));
  for (const path of [bashrc, ...await groupRcFiles(cmd)]) {
    if (!wanted.includes(path) && await removeLine(cmd, path, line) && !cmd.json) await cmd.write(`  Removed ${binPath} from PATH in ${path}\n`);
  }
  for (const path of wanted) {
    if (await addLine(cmd, path, line)) {
      if (!cmd.json) await cmd.write(`  Added ${binPath} to PATH in ${path}\n`);
    } else if (!cmd.json) await cmd.write(`  bin/ already in PATH in ${path}\n`);
  }
};

/** Take a module's PATH line out of `/etc/bashrc` and every group's setup file. */
export const removePathLine = async (cmd: Command, binPath: string): Promise<void> => {
  const line = buildPathExportLine(binPath);
  for (const path of [join(cmd.env.ETC_PATH || ETC_PATH, 'bashrc'), ...await groupRcFiles(cmd)]) {
    try {
      if (await removeLine(cmd, path, line) && !cmd.json) await cmd.write(`  Removed ${binPath} from PATH in ${path}\n`);
    } catch (error) {
      await cmd.writeError(`  failed to update ${path}: ${(error as Error).message}\n`);
    }
  }
};
