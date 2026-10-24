import { join } from '@std/path';
import { ADMIN_ACCESS } from '../../../../lib/access/mod.ts';
import { moduleConfigDir } from '../../../../lib/config/paths.ts';
import { ETC_PATH, UI_NAV_D_PATH } from '../../../../lib/paths.ts';
import type { Command } from '../../command.ts';
import { linkOwned, type OwnedLink, unlinkOwned } from './owned-link.ts';

/** A drop-in directory's name: `<x>.d`. */
const DROP_IN = /^[a-z0-9][a-z0-9-]*\.d$/;

const etcOf = (cmd: Command): string => cmd.env.ETC_PATH || ETC_PATH;

/** The names in a directory, none when it is not there. */
const namesIn = async (path: string, cmd: Command): Promise<string[]> => {
  try {
    return (await cmd.sys.vfs.children(ADMIN_ACCESS, path)).map((child) => child.name);
  } catch {
    return [];
  }
};

/**
 * The files of a module's that `mod setup` links into `/etc` (see `owned-link.ts`):
 *
 * - its navigation entries, `ui/nav.json`, as `/etc/ui/nav.d/<name>.json` for `ui-nav` to read;
 * - its own choice of settings, `etc/config`, as `/etc/config.d/<name>`, which `/etc/bashrc`
 *   sources before the administrator's `/etc/config`;
 * - each drop-in directory it ships, `etc/<x>.d`, as `/etc/<x>.d/<name>`: what it gives whichever
 *   module reads `/etc/<x>.d/*`, which core does not read and need not know.
 *
 * Linked rather than copied with the rest of `etc/`, so a new version of the module is seen at once
 * and `mod remove` takes them back. A drop-in link the module no longer ships is found in `/etc`
 * and listed too, so it is retired.
 */
const linksOf = async (cmd: Command, name: string, modulePath: string): Promise<OwnedLink[]> => {
  const etc = etcOf(cmd);
  const links: OwnedLink[] = [
    { source: join(modulePath, 'ui', 'nav.json'), linkPath: join(UI_NAV_D_PATH, `${name}.json`), what: 'navigation' },
    { source: join(modulePath, 'etc', 'config'), linkPath: join(moduleConfigDir(cmd.env.ETC_PATH), name), what: 'settings' },
  ];
  const shipped = (await namesIn(join(modulePath, 'etc'), cmd)).filter((entry) => DROP_IN.test(entry));
  const linked = [];
  for (const dir of (await namesIn(etc, cmd)).filter((entry) => DROP_IN.test(entry))) {
    if ((await namesIn(join(etc, dir), cmd)).includes(name)) linked.push(dir);
  }
  for (const dir of new Set([...shipped, ...linked])) {
    const link = { source: join(modulePath, 'etc', dir), linkPath: join(etc, dir, name), what: dir };
    if (!links.some((known) => known.linkPath === link.linkPath)) links.push(link);
  }
  return links;
};

/** Whether a module's `etc/` entry is linked rather than copied into `/etc`. */
export const isLinkedEtc = (entry: string): boolean => entry === 'config' || DROP_IN.test(entry);

/** Link the module's files, or retire links it no longer ships files for. Returns the problems, if any. */
export const linkModuleFiles = async (cmd: Command, name: string, modulePath: string): Promise<string[]> => {
  const problems: string[] = [];
  for (const link of await linksOf(cmd, name, modulePath)) {
    const problem = await linkOwned(cmd, modulePath, link);
    if (problem) problems.push(problem);
  }
  return problems;
};

/** Remove the module's links, those that are the module's. */
export const unlinkModuleFiles = async (cmd: Command, name: string, modulePath: string): Promise<void> => {
  for (const link of await linksOf(cmd, name, modulePath)) await unlinkOwned(cmd, modulePath, link);
};
