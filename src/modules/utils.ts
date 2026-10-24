import { join } from '@std/path';
import { toText } from '@std/streams/to-text';
import type { Access } from '../lib/access/mod.ts';
import type { NodeVFS } from '../vfs/mod.ts';
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
