/**
 * A value read from the VFS and kept per VFS, for what nearly every call asks and few writes
 * change: the unlisted directories a library view leaves out, the folders that say which
 * processing they want.
 *
 * The value is kept until the VFS announces an event that `changes` says may alter it, and for
 * `KEEP_MS` at most, which covers a write the VFS never announced. A failed read is not kept.
 */

import { ADMIN_ACCESS } from './access/constants.ts';
import type { ModuleVFS } from '../vfs/node-vfs.ts';
import type { NodeEvent } from '../vfs/types.ts';

/** How long a value is kept when no change is seen. */
const KEEP_MS = 60_000;

type Kept<T> = {
  /** Resolves once the VFS's changes are watched, whether or not it can announce them. */
  watching: Promise<void>;
  value?: Promise<T>;
  at: number;
};

/** What a kept value is read from and which events may change it. */
type KeptOptions<T> = {
  read: (vfs: ModuleVFS) => Promise<T>;
  /** The node types whose events can change it; only those are watched. */
  nodeTypes: string[];
  changes: (event: NodeEvent) => boolean;
};

/** A reader of the value `options` describe, read once per VFS and kept (see the file's comment). */
export const keptPerVfs = <T>(options: KeptOptions<T>): (vfs: ModuleVFS) => Promise<T> => {
  const kept = new WeakMap<ModuleVFS, Kept<T>>();

  return async (vfs) => {
    let entry = kept.get(vfs);
    if (!entry) {
      const fresh: Kept<T> = {
        at: 0,
        watching: watch(vfs, options, () => {
          fresh.value = undefined;
        }),
      };
      kept.set(vfs, entry = fresh);
    }
    await entry.watching;
    if (entry.value && Date.now() - entry.at > KEEP_MS) entry.value = undefined;
    let value = entry.value;
    if (!value) {
      const reading = value = options.read(vfs);
      const current = entry;
      current.value = reading;
      current.at = Date.now();
      reading.catch(() => {
        if (current.value === reading) current.value = undefined;
      });
    }
    return await value;
  };
};

/** Call `changed` after an event of `options.nodeTypes` that `options.changes`, when the VFS announces its changes. */
const watch = async <T>(vfs: ModuleVFS, options: KeptOptions<T>, changed: () => void): Promise<void> => {
  if (!vfs.subscribe) return;
  await vfs.subscribe(() => ADMIN_ACCESS, (event) => {
    if (options.changes(event)) changed();
  }, { nodeTypes: options.nodeTypes, eventTypes: ['created', 'updated', 'moved', 'deleted'] });
};
