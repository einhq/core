import type { CmdReturn, Command } from '@ein/client';
import { collectUnknownFlags, isAdmin, isVisitor, NodeNotFoundError, parseArgs, reportUnknownFlags } from '@ein/client';
import { GROUP_HOMES_PATH, groupHomePath, HOME_UI_NAV_D, HOME_UI_NAV_FILE, UI_NAV_D_PATH, UI_NAV_PATH } from '@ein/paths';
import { toText } from '@std/streams/to-text';
import { groupEntriesFor } from '../../../lib/auth/member-gids.ts';
import { type NamedLayer, type NavLayer, resolveNav, type UiNav } from '@ui/nav';

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

export const uiNav = async (cmd: Command): CmdReturn => {
  const unknown: string[] = [];
  const flags = parseArgs(cmd.args, { boolean: ['help'], unknown: collectUnknownFlags(unknown) });
  if (await reportUnknownFlags(cmd, unknown)) return 1;
  if (flags.help) {
    await cmd.writeLn(
      "usage: ui-nav\nThe sidebar and top bar for the caller: every module's /etc/ui/nav.d fragment and those of the modules kept to the caller's groups in /groups/<group>/.ui/nav.d (an administrator's: every group's), then /etc/ui/nav.json, then /groups/<group>/.ui/nav.json for each of the caller's groups, then ~/.ui/nav.json.",
    );
    return 0;
  }

  const warnings: string[] = [];
  const { groups } = await groupEntriesFor(cmd.sys.vfs, cmd.access, GROUP_HOMES_PATH);
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

  const nav = resolveNav(fragments, overlays, { admin: isAdmin(cmd.access), guest: isVisitor(cmd.access) });
  const answer: UiNav = { ...nav, warnings: [...warnings, ...nav.warnings] };

  if (cmd.json) {
    await cmd.writeJSON(answer satisfies UiNav);
    return 0;
  }

  const keys = (entry: { shortcut?: string }) => (entry.shortcut ? ` (${entry.shortcut})` : '');
  for (const section of answer.sections) {
    await cmd.writeLn(section.label ?? `(${section.id})`);
    for (const item of section.items) await cmd.writeLn(`  ${item.label.padEnd(16)} ${item.to.padEnd(16)} ${item.id}${keys(item)}`);
  }
  await cmd.writeLn('top bar');
  for (const entry of answer.topbar) {
    await cmd.writeLn(`  ${entry.title.padEnd(16)} ${entry.id}${keys(entry)}`);
    for (const row of entry.menu ?? []) await cmd.writeLn(`    ${row.title.padEnd(14)} ${row.id}${keys(row)}`);
  }
  if (answer.panels.length > 0) await cmd.writeLn('panels');
  for (const panel of answer.panels) await cmd.writeLn(`  ${panel.slot.padEnd(16)} ${panel.label.padEnd(16)} ${panel.route.padEnd(24)} ${panel.id}`);
  if (answer.layers.length > 0) await cmd.writeLn('map layers');
  for (const layer of answer.layers) await cmd.writeLn(`  ${layer.label.padEnd(16)} ${layer.id}`);
  for (const warning of answer.warnings) await cmd.writeError(`ui-nav: ${warning}\n`);
  return 0;
};

uiNav.spec = {
  name: 'ui-nav',
  effect: 'read' as const,
  description:
    "The Web UI's sidebar, top bar, panels and map layers for the caller, from every module's entries and the administrator's, the caller's groups' and the user's changes",
  args: [],
  flags: [],
};
