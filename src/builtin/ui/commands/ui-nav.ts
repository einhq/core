import type { CmdReturn, Command } from '@ein/client';
import { collectUnknownFlags, isAdmin, isVisitor, NodeNotFoundError, parseArgs, reportUnknownFlags } from '@ein/client';
import { UI_NAV_D_PATH, UI_NAV_PATH, USER_UI_NAV_FILE } from '@ein/paths';
import { toText } from '@std/streams/to-text';
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

export const uiNav = async (cmd: Command): CmdReturn => {
  const unknown: string[] = [];
  const flags = parseArgs(cmd.args, { boolean: ['help'], unknown: collectUnknownFlags(unknown) });
  if (await reportUnknownFlags(cmd, unknown)) return 1;
  if (flags.help) {
    await cmd.writeLn("usage: ui-nav\nThe sidebar and top bar for the caller: every module's /etc/ui/nav.d fragment, then /etc/ui/nav.json, then ~/.ui/nav.json.");
    return 0;
  }

  const warnings: string[] = [];
  const fragments: NamedLayer[] = [];
  let names: string[] = [];
  try {
    names = (await cmd.sys.vfs.children(cmd.access, UI_NAV_D_PATH)).map((child) => child.name);
  } catch (error) {
    if (!(error instanceof NodeNotFoundError)) throw error;
  }
  for (const name of names.filter((n) => n.endsWith('.json')).sort()) {
    const layer = await readLayer(cmd, `${UI_NAV_D_PATH}/${name}`, warnings);
    if (layer) fragments.push({ source: name.slice(0, -'.json'.length), layer });
  }

  const overlays: NamedLayer[] = [];
  const home = cmd.env.HOME;
  for (const path of [UI_NAV_PATH, ...(home ? [`${home}/${USER_UI_NAV_FILE}`] : [])]) {
    const layer = await readLayer(cmd, path, warnings);
    if (layer) overlays.push({ source: path, layer });
  }

  const nav = resolveNav(fragments, overlays, { admin: isAdmin(cmd.access), guest: isVisitor(cmd.access) });
  const answer: UiNav = { ...nav, warnings: [...warnings, ...nav.warnings] };

  if (cmd.json) {
    await cmd.writeJSON(answer satisfies UiNav);
    return 0;
  }

  for (const section of answer.sections) {
    await cmd.writeLn(section.label ?? `(${section.id})`);
    for (const item of section.items) await cmd.writeLn(`  ${item.label.padEnd(16)} ${item.to.padEnd(16)} ${item.id}`);
  }
  await cmd.writeLn('top bar');
  const keys = (entry: { shortcut?: string }) => (entry.shortcut ? ` (${entry.shortcut})` : '');
  for (const entry of answer.topbar) {
    await cmd.writeLn(`  ${entry.title.padEnd(16)} ${entry.id}${keys(entry)}`);
    for (const row of entry.menu ?? []) await cmd.writeLn(`    ${row.title.padEnd(14)} ${row.id}${keys(row)}`);
  }
  if (answer.panels.length > 0) await cmd.writeLn('panels');
  for (const panel of answer.panels) await cmd.writeLn(`  ${panel.slot.padEnd(16)} ${panel.label.padEnd(16)} ${panel.route.padEnd(24)} ${panel.id}`);
  for (const warning of answer.warnings) await cmd.writeError(`ui-nav: ${warning}\n`);
  return 0;
};

uiNav.spec = {
  name: 'ui-nav',
  effect: 'read' as const,
  description: "The web UI's sidebar, top bar and panels for the caller, from every module's entries and the administrator's and the user's changes",
  args: [],
  flags: [],
};
