import type { Access } from './access/types.ts';
import type { NodeVFS } from '../vfs/node-vfs.ts';

/**
 * The minimum a helper needs in order to touch the VFS on a command's behalf.
 *
 * Helpers exported to modules (`withHostPath`, `readComments`) take this rather than the full
 * `Command`, so they accept both core's `Command` and the deliberately narrower one modules see
 * through `@ein/client`. Asking for the whole interface would drag core's process-lifecycle
 * and terminal-control surface into the module contract for no reason.
 */
export type VfsCommand = {
  readonly sys: { readonly vfs: NodeVFS };
  readonly access: Access;
  readonly env: Record<string, string>;
};
