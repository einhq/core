/**
 * The navigation as one reader gets it: every module's fragment, the overlays laid over them in
 * order, resolved for the caller (`resolveNav`). What `ui-nav` answers, and what a module reads to
 * know the map layers its caller is offered.
 */

import type { Command } from '../../../client/mod.ts';
import { isAdmin, isVisitor } from '../../../lib/access/verify-access.ts';
import { NodeNotFoundError } from '../../../vfs/errors.ts';
import { GROUP_HOMES_PATH, groupHomePath, HOME_UI_NAV_D, HOME_UI_NAV_FILE, UI_NAV_D_PATH, UI_NAV_PATH } from '@ein/paths';
import { toText } from '@std/streams/to-text';
import { groupEntriesFor, groupGid } from '../../../lib/auth/member-gids.ts';
import { type NamedLayer, type NavLayer, resolveNav, type UiNav } from './nav.ts';

/** The groups the layers' entries are kept to (`group`) that the caller is a member of. */
const groupsNamed = async (cmd: Command, layers: NamedLayer[]): Promise<string[]> => {
  const named = new Set<string>();
  for (const { layer } of layers) {
    for (const list of Object.values(layer ?? {})) {
      if (!Array.isArray(list)) continue;
      for (const entry of list as unknown[]) {
        const group = entry && typeof entry === 'object' ? (entry as { group?: unknown }).group : undefined;
        if (typeof group === 'string') named.add(group);
      }
    }
  }
  const members = await Promise.all([...named].map(async (name) => {
    const gid = await groupGid(cmd.sys.vfs, name);
    return gid !== undefined && cmd.access.gids.includes(gid) ? name : undefined;
  }));
  return members.filter((name): name is string => name !== undefined);
};

/** A file's JSON, `undefined` when it is not there, a warning when it is not JSON. */
const readLayer = async (cmd: Command, path: string, warnings: string[]): Promise<NavLayer | undefined> => {
  try {
    const handle = await cmd.sys.vfs.open(cmd.access, path, { mode: 'r' });
    try {
      return JSON.parse(await toText(handle.readable)) as NavLayer;
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error instanceof NodeNotFoundError) return undefined;
    warnings.push(`${path}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
};

/** The names of a directory's children, none when it is not there. */
const childNames = async (cmd: Command, path: string): Promise<string[]> => {
  try {
    return (await cmd.sys.vfs.children(cmd.access, path)).map((child) => child.name).sort();
  } catch (error) {
    if (error instanceof NodeNotFoundError) return [];
    throw error;
  }
};

/**
 * The caller's navigation: everyone's modules' fragments in /etc/ui/nav.d, then those of the modules
 * kept to the caller's groups (an administrator's: every group's), laid under /etc/ui/nav.json, each
 * of the caller's groups' .ui/nav.json and ~/.ui/nav.json; with what could not be read among the
 * warnings.
 */
export const readUiNav = async (cmd: Command): Promise<UiNav> => {
  const warnings: string[] = [];
  const groups = await groupEntriesFor(cmd.sys.vfs, cmd.access, GROUP_HOMES_PATH);
  // An administrator is given every module, so the fragments in every group's home.
  const fragmentGroups = isAdmin(cmd.access) ? await childNames(cmd, GROUP_HOMES_PATH) : groups;

  // Everyone's modules, then those kept to the caller's groups; one in several of them once.
  const fragments: NamedLayer[] = [];
  for (const dir of [UI_NAV_D_PATH, ...fragmentGroups.map((group) => `${groupHomePath(group)}/${HOME_UI_NAV_D}`)]) {
    for (const name of (await childNames(cmd, dir)).filter((n) => n.endsWith('.json'))) {
      const source = name.slice(0, -'.json'.length);
      if (fragments.some((fragment) => fragment.source === source)) continue;
      const layer = await readLayer(cmd, `${dir}/${name}`, warnings);
      if (layer) fragments.push({ source, layer });
    }
  }

  const overlays: NamedLayer[] = [];
  const home = cmd.env.HOME;
  const groupOverlays = groups.map((name) => `${groupHomePath(name)}/${HOME_UI_NAV_FILE}`);
  for (const path of [UI_NAV_PATH, ...groupOverlays, ...(home ? [`${home}/${HOME_UI_NAV_FILE}`] : [])]) {
    const layer = await readLayer(cmd, path, warnings);
    if (layer) overlays.push({ source: path, layer });
  }

  const memberOf = await groupsNamed(cmd, [...fragments, ...overlays]);
  const nav = resolveNav(fragments, overlays, { admin: isAdmin(cmd.access), guest: isVisitor(cmd.access), groups: memberOf });
  return { ...nav, warnings: [...warnings, ...nav.warnings] };
};
