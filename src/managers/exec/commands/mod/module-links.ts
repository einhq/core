import { join } from '@std/path';
import { ADMIN_ACCESS, ADMIN_GROUPNAME } from '../../../../lib/access/mod.ts';
import { moduleConfigDir } from '../../../../lib/config/paths.ts';
import { ETC_PATH, GROUP_HOMES_PATH, groupHomePath, HOME_UI_NAV_D, MOD_PATH, UI_NAV_D_PATH } from '../../../../lib/paths.ts';
import { shq } from '../../../../lib/shell-quote/mod.ts';
import { sameFiles } from '../../../../modules/install.ts';
import { readManifests } from '../../../../modules/mod.ts';
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

/** The groups of `groups` whose homes hold a module's navigation: all but the administrators', who read every group's. */
const homedGroups = (groups: string[]): string[] => groups.filter((group) => group !== ADMIN_GROUPNAME);

/**
 * Where a module's navigation entries are linked: `/etc/ui/nav.d/<name>.json` for a module that is
 * everyone's, else `/groups/<group>/.ui/nav.d/<name>.json` in the home of each of its `groups` that
 * has one. Each other place it is linked from, found there, is listed to be retired.
 */
const navLinks = async (cmd: Command, name: string, modulePath: string, groups: string[]): Promise<OwnedLink[]> => {
  const source = join(modulePath, 'ui', 'nav.json');
  const file = `${name}.json`;
  const inGroup = (group: string) => join(groupHomePath(group), HOME_UI_NAV_D, file);
  const homed = [];
  for (const group of homedGroups(groups)) {
    if (await cmd.sys.vfs.exists(ADMIN_ACCESS, groupHomePath(group), { follow: false })) homed.push(group);
  }
  const wanted = groups.length === 0 ? [join(UI_NAV_D_PATH, file)] : homed.map(inGroup);
  const linked = [join(UI_NAV_D_PATH, file)];
  for (const group of await namesIn(GROUP_HOMES_PATH, cmd)) {
    if ((await namesIn(join(groupHomePath(group), HOME_UI_NAV_D), cmd)).includes(file)) linked.push(inGroup(group));
  }
  return [
    ...wanted.map((linkPath) => ({ source, linkPath, what: 'navigation' })),
    ...linked.filter((linkPath) => !wanted.includes(linkPath)).map((linkPath) => ({ source, linkPath, what: 'navigation', retire: true })),
  ];
};

/**
 * Give each of `groups` that has no home one (`group-home`), for the navigation of a module kept to
 * them. Returns the problems, if any.
 */
const ensureHomes = async (cmd: Command, groups: string[]): Promise<string[]> => {
  const problems: string[] = [];
  for (const group of homedGroups(groups)) {
    const home = groupHomePath(group);
    if (await cmd.sys.vfs.exists(ADMIN_ACCESS, home, { follow: false })) continue;
    const res = await cmd.execute(`group-home ${shq(group)}`);
    if (res.code !== 0) problems.push(`no navigation for group ${group}, which has no home: ${res.stderr.trim()}`);
    else if (!cmd.json) await cmd.write(`  Gave group ${group} its home at ${home}, for the navigation\n`);
  }
  return problems;
};

/**
 * The files of a module's that `mod setup` links into `/etc` (see `owned-link.ts`):
 *
 * - its navigation entries, `ui/nav.json`, where `navLinks` says, for `ui-nav` to read; a group it
 *   is kept to is given a home to hold them;
 * - its own choice of settings, `etc/config`, as `/etc/config.d/<name>`, which `/etc/bashrc`
 *   sources before the administrator's `/etc/config`;
 * - each drop-in directory it ships, `etc/<x>.d`, as `/etc/<x>.d/<name>`: what it gives whichever
 *   module reads `/etc/<x>.d/*`, which core does not read and need not know.
 *
 * Linked rather than copied with the rest of `etc/`, so a new version of the module is seen at once
 * and `mod remove` takes them back. A drop-in link the module no longer ships is found in `/etc`
 * and listed too, so it is retired.
 */
const linksOf = async (cmd: Command, name: string, modulePath: string, groups: string[]): Promise<OwnedLink[]> => {
  const etc = etcOf(cmd);
  const links: OwnedLink[] = [
    ...await navLinks(cmd, name, modulePath, groups),
    { source: join(modulePath, 'etc', 'config'), linkPath: join(moduleConfigDir(cmd.env.ETC_PATH), name), what: 'settings' },
  ];
  const shipped = await dropInsOf(cmd, modulePath);
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

/**
 * Link the module's files, its navigation for `groups` (none: everyone), or retire links it no
 * longer ships files for. Returns the problems, if any.
 */
export const linkModuleFiles = async (cmd: Command, name: string, modulePath: string, groups: string[]): Promise<string[]> => {
  const problems = await cmd.sys.vfs.exists(cmd.access, join(modulePath, 'ui', 'nav.json')) ? await ensureHomes(cmd, groups) : [];
  for (const link of await linksOf(cmd, name, modulePath, groups)) {
    const problem = await linkOwned(cmd, modulePath, link);
    if (problem) problems.push(problem);
  }
  return problems;
};

/** Remove the module's links, those that are the module's. */
export const unlinkModuleFiles = async (cmd: Command, name: string, modulePath: string): Promise<void> => {
  for (const link of await linksOf(cmd, name, modulePath, [])) await unlinkOwned(cmd, modulePath, link);
};

/** The drop-in directories (`etc/<name>.d`) a module's tree at `root` ships. */
export const dropInsOf = async (cmd: Command, root: string): Promise<string[]> => (await namesIn(join(root, 'etc'), cmd)).filter((entry) => DROP_IN.test(entry));

/**
 * The drop-in directories a module's tree at `after` changes against the one at `before`: one
 * added, removed, or with a file added, removed or changed. A module new here (`before`
 * undefined) changes every one it ships.
 */
export const changedDropIns = async (cmd: Command, before: string | undefined, after: string): Promise<string[]> => {
  const dirs = new Set([...before === undefined ? [] : await dropInsOf(cmd, before), ...await dropInsOf(cmd, after)]);
  const changed: string[] = [];
  for (const dir of [...dirs].sort()) {
    if (!await sameFiles(cmd.sys.vfs, cmd.access, before && join(before, 'etc', dir), join(after, 'etc', dir))) changed.push(dir);
  }
  return changed;
};

/** The services the modules say read one of the drop-in directories `dirs` (`dropIns`), each once. */
export const dropInReaders = async (cmd: Command, dirs: Iterable<string>): Promise<string[]> => {
  const wanted = new Set(dirs);
  const readers = new Set<string>();
  if (wanted.size === 0) return [];
  for (const manifest of (await readManifests(cmd.sys.vfs, cmd.access, cmd.env.MOD_PATH || MOD_PATH)).values()) {
    for (const [dir, { restarts = [] }] of Object.entries(manifest.dropIns ?? {})) {
      if (wanted.has(dir)) { for (const service of restarts) readers.add(service); }
    }
  }
  return [...readers].sort();
};
