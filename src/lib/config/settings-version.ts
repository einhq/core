import { basename, dirname, join } from '@std/path';
import { ADMIN_ACCESS } from '../access/constants.ts';
import type { NodeVFS } from '../../vfs/node-vfs.ts';
import { BASHRC_GROUPS_PATH, HOMES_PATH } from '../paths.ts';
import { environmentPath, moduleConfigDir, systemConfigPath } from './paths.ts';

/**
 * How many times the files a shell's environment is built from have changed: `bashrc` in
 * `etcPath` and every layer it sources — the deployment's, the modules', the system's and each
 * user's `.config` — and each group's setup in `/etc/bashrc.d`. A shell that saw an earlier count
 * holds settings older than the files.
 */
type Version = { count: number; watched: Promise<boolean> };

const versions = new WeakMap<NodeVFS, Map<string, Version>>();

/** Whether a write to `path` changes what sourcing `etcPath`'s `bashrc` gives. */
const changesSettings = (path: string, etcPath: string): boolean =>
  path === join(etcPath, 'bashrc') ||
  dirname(path) === BASHRC_GROUPS_PATH ||
  path === environmentPath(etcPath) ||
  path === systemConfigPath(etcPath) ||
  dirname(path) === moduleConfigDir(etcPath) ||
  (basename(path) === '.config' && dirname(dirname(path)) === HOMES_PATH);

/**
 * The count of changes to the settings files under `etcPath`, counted from the first call for
 * `vfs` on; undefined when `vfs` cannot report changes.
 *
 * Subscription handlers run before the write that triggers them returns, so once a `config set`
 * is done, every later call sees the new count.
 */
export const settingsVersion = async (vfs: NodeVFS, etcPath: string): Promise<number | undefined> => {
  let byEtc = versions.get(vfs);
  if (!byEtc) versions.set(vfs, byEtc = new Map());
  let version = byEtc.get(etcPath);
  if (!version) {
    const entry: Version = { count: 0, watched: watch(vfs, etcPath, () => entry.count++) };
    byEtc.set(etcPath, version = entry);
  }
  return await version.watched ? version.count : undefined;
};

const watch = async (vfs: NodeVFS, etcPath: string, changed: () => void): Promise<boolean> => {
  if (!vfs.subscribe) return false;
  for (const pathPrefix of [etcPath, HOMES_PATH]) {
    await vfs.subscribe(() => ADMIN_ACCESS, (event) => {
      if (changesSettings(event.path, etcPath)) changed();
    }, { pathPrefix });
  }
  return true;
};
