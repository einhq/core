/**
 * A VFS path as a file an outside process can open.
 *
 * The EMS client hands the media service physical paths, and gets them here; exported to modules
 * through `@ein/client`, so this imports nothing beyond the VFS.
 */

import { extname } from '@std/path';
import { createLogger } from '../../managers/logger/mod.ts';
import type { VfsCommand } from '../vfs-command.ts';

const logger = createLogger('host-path');

/** A db-tier node staged as a real file for the duration of one call. */
type StagedFile = {
  vfsPath: string;
  hostPath: string;
  size: number;
  mtime: number;
};

/** Node types whose bytes can be staged; anything else has no content to copy. */
const CONTENT_TYPES = new Set(['file', 'blob']);

const statHost = async (path: string): Promise<{ size: number; mtime: number }> => {
  try {
    const info = await Deno.stat(path);
    return { size: info.size, mtime: info.mtime?.getTime() ?? 0 };
  } catch {
    return { size: -1, mtime: 0 };
  }
};

/**
 * Copy a node with no physical path out to a temp file.
 *
 * Nodes on the `db` tier live in a PostgreSQL large object, so there is nothing on disk for
 * another process to open — `stat.path` is empty. Staging a copy makes those nodes work like
 * any other. The extension is preserved because the media tools pick their format from it.
 */
const stageNode = async (cmd: VfsCommand, vfsPath: string): Promise<StagedFile | undefined> => {
  let type: string;
  try {
    type = (await cmd.sys.vfs.get(cmd.access, vfsPath)).type;
  } catch {
    return undefined;
  }
  if (!CONTENT_TYPES.has(type)) return undefined;

  const dir = cmd.env.EXTERNAL_FILE_TMP_PATH || undefined;
  const suffix = extname(vfsPath);
  let hostPath: string;
  try {
    hostPath = await Deno.makeTempFile({ dir, prefix: 'mrx-ext-', suffix });
  } catch {
    hostPath = await Deno.makeTempFile({ prefix: 'mrx-ext-', suffix });
  }

  // A node that exists but holds nothing yet is an output the tool is about to write, so an
  // empty temp file is the correct staging for it — hence failures here are not fatal.
  try {
    const handle = await cmd.sys.vfs.open(cmd.access, vfsPath, { mode: 'r' });
    try {
      const dest = await Deno.open(hostPath, { write: true, truncate: true });
      await handle.readable.pipeTo(dest.writable);
    } finally {
      await handle.close().catch(() => {});
    }
  } catch (error) {
    logger.debug('staged an empty file (node has no readable content yet)', { path: vfsPath, error });
  }

  return { vfsPath, hostPath, ...(await statHost(hostPath)) };
};

/**
 * Copy a staged file back if the command changed it, then remove it.
 *
 * A caller's path may be an input or an output, so both are staged and only those the media
 * service actually wrote are copied back — writing every staged input back would emit a
 * spurious `updated` event and re-trigger whatever pipeline is watching the node.
 */
const unstageNode = async (cmd: VfsCommand, staged: StagedFile): Promise<void> => {
  try {
    const after = await statHost(staged.hostPath);
    if (after.size >= 0 && (after.size !== staged.size || after.mtime !== staged.mtime)) {
      const src = await Deno.open(staged.hostPath, { read: true });
      const dest = await cmd.sys.vfs.open(cmd.access, staged.vfsPath, { mode: 'w' });
      try {
        await src.readable.pipeTo(dest.writable);
      } finally {
        await dest.close().catch(() => {});
      }
    }
  } catch (error) {
    logger.error('failed to copy a staged file back into the VFS', { path: staged.vfsPath, error });
  } finally {
    await Deno.remove(staged.hostPath).catch(() => {});
  }
};

/**
 * Resolve a VFS path to a physical one for the duration of `fn`.
 *
 * A process outside this one can only open a real file, and a db-tier node has none — so it is
 * staged and cleaned up afterwards.
 *
 * A path that resolves to no node is passed through unchanged: callers legitimately mix VFS
 * paths with host paths they made themselves (ffmpeg keyframes in a temp dir).
 */
export const withHostPath = async <T>(
  cmd: VfsCommand,
  vfsPath: string,
  fn: (hostPath: string) => Promise<T>,
): Promise<T> => {
  let stat;
  try {
    stat = await cmd.sys.vfs.stat(cmd.access, vfsPath);
  } catch {
    return await fn(vfsPath); // not a node — already a host path
  }

  const physical = stat.path as string | undefined;
  if (physical) return await fn(physical);

  const file = await stageNode(cmd, vfsPath);
  if (!file) return await fn(vfsPath);
  try {
    return await fn(file.hostPath);
  } finally {
    await unstageNode(cmd, file);
  }
};

/** `withHostPath` for a list of paths, all resolved for the duration of `fn`. */
export const withHostPaths = async <T>(
  cmd: VfsCommand,
  vfsPaths: string[],
  fn: (hostPaths: string[]) => Promise<T>,
): Promise<T> => {
  const resolve = async (index: number, acc: string[]): Promise<T> => {
    if (index === vfsPaths.length) return await fn(acc);
    return await withHostPath(cmd, vfsPaths[index], (hostPath) => resolve(index + 1, [...acc, hostPath]));
  };
  return await resolve(0, []);
};
