import { readManifests } from '../../../../modules/mod.ts';
import type { Owned } from '../../../../lib/reference/types.ts';
import type { Command } from '../../command.ts';

/**
 * Core's descriptions, then each installed module's, owner-tagged, in module-name order.
 *
 * Read from the manifests at every call rather than registered at `mod setup` as settings are:
 * nothing but the documentation reads these, and reading `/usr/modules` is what makes the
 * answer the installed modules, whatever state their setup is in.
 */
export const describedBy = async <T extends object>(cmd: Command, core: T[], field: 'nodeTypes' | 'environment'): Promise<Owned<T>[]> => {
  const manifests = await readManifests(cmd.sys.vfs, cmd.access, cmd.env.MOD_PATH);
  const described: Owned<T>[] = core.map((doc) => ({ ...doc }));
  for (const [name, manifest] of [...manifests].sort(([a], [b]) => a.localeCompare(b))) {
    const declared = manifest[field];
    if (!Array.isArray(declared)) continue;
    for (const doc of declared as T[]) described.push({ ...doc, owner: manifest.name || name });
  }
  return described;
};
