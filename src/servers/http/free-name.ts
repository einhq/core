import { Access } from '../../lib/access/mod.ts';
import { NodeAlreadyExistsError } from '../../vfs/mod.ts';
import { NODE_TYPE_FILE } from '../../vfs/types/file.ts';
import { numberedName } from './numbered-name.ts';
import { HttpServerConfig } from './types.ts';

/** How many numbered names an upload tries before giving up on a directory. */
const MAX_NUMBERED = 10_000;

/**
 * Create an empty file node in `dirPath` under `name` or its first free numbered name, as `access`,
 * and return that name; undefined when every one is taken. The store's unique-name rule decides
 * which of two uploads at once gets which name, so both land and neither replaces the other.
 */
export async function createFreeName(config: HttpServerConfig, access: Access, dirPath: string, name: string): Promise<string | undefined> {
  for (let n = 1; n <= MAX_NUMBERED; n++) {
    const candidate = n === 1 ? name : numberedName(name, n);
    try {
      await config.vfs.create(access, NODE_TYPE_FILE, dirPath, candidate, { attrs: { name: candidate } });
      return candidate;
    } catch (e) {
      if (!(e instanceof NodeAlreadyExistsError)) throw e;
    }
  }
  return undefined;
}
