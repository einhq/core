import { basename, dirname, join } from '@std/path';
import { toText } from '@std/streams/to-text';
import type { Access } from '../lib/access/mod.ts';
import type { NodeVFS } from '../vfs/mod.ts';
import { type FileAttrs, NODE_TYPE_FILE } from '../vfs/types/file.ts';
import { MOD_JSON_NAME, type ModuleManifest } from './types.ts';

/**
 * Read mod.json from a module directory.
 * Returns null if mod.json doesn't exist.
 */
export async function readModJson(
  vfs: NodeVFS,
  access: Access,
  modulePath: string,
): Promise<ModuleManifest | null> {
  const modJsonPath = join(modulePath, MOD_JSON_NAME);

  try {
    const handle = await vfs.open(access, modJsonPath, { mode: 'r' });
    try {
      const content = await toText(handle.readable);
      return JSON.parse(content) as ModuleManifest;
    } finally {
      await handle.close();
    }
  } catch {
    return null;
  }
}

/**
 * Write mod.json to a module directory.
 * Creates or updates the mod.json file.
 */
export async function writeModJson(
  vfs: NodeVFS,
  access: Access,
  modulePath: string,
  manifest: ModuleManifest,
): Promise<void> {
  const modJsonPath = join(modulePath, MOD_JSON_NAME);
  const content = JSON.stringify(manifest, null, 2);
  const encoded = new TextEncoder().encode(content);

  try {
    await vfs.get(access, modJsonPath);

    // Update existing file
    const handle = await vfs.open(access, modJsonPath, { mode: 'w' });
    try {
      await handle.write(encoded);
    } finally {
      await handle.close();
    }
  } catch {
    // mod.json doesn't exist, create new file node
    const parentPath = dirname(modJsonPath);
    const name = basename(modJsonPath);
    const attrs: FileAttrs = { name, mimetype: 'application/json', size: encoded.length };

    await vfs.create(access, NODE_TYPE_FILE, parentPath, name, { attrs });

    const handle = await vfs.open(access, modJsonPath, { mode: 'w' });
    try {
      await handle.write(encoded);
    } finally {
      await handle.close();
    }
  }
}

/**
 * Check if a directory is a module (has mod.json)
 */
export async function isModule(
  vfs: NodeVFS,
  access: Access,
  path: string,
): Promise<boolean> {
  const modJsonPath = join(path, MOD_JSON_NAME);
  return await vfs.exists(access, modJsonPath);
}
