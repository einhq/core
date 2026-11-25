import type { CmdReturn, Command } from '@ein/client';
import { collectUnknownFlags, parseArgs, reportUnknownFlags } from '@ein/client';
import type { UiNav } from '@ui/nav';
import { readUiNav } from '../lib/read-nav.ts';

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

  const answer = await readUiNav(cmd);

  if (cmd.json) {
    await cmd.writeJSON(answer satisfies UiNav);
    return 0;
  }

  const keys = (entry: { shortcut?: string }) => (entry.shortcut ? ` (${entry.shortcut})` : '');
  for (const section of answer.sections.filter((section) => section.items.length > 0)) {
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
  if (answer.styles.length > 0) await cmd.writeLn('map styles');
  for (const style of answer.styles) await cmd.writeLn(`  ${style.label.padEnd(16)} ${style.id}`);
  if (answer.layers.length > 0) await cmd.writeLn('map layers');
  for (const layer of answer.layers) await cmd.writeLn(`  ${layer.label.padEnd(16)} ${(layer.route ?? 'tiles').padEnd(24)} ${layer.id}`);
  for (const warning of answer.warnings) await cmd.writeError(`ui-nav: ${warning}\n`);
  return 0;
};

uiNav.spec = {
  name: 'ui-nav',
  effect: 'read' as const,
  description:
    "The Web UI's sidebar, top bar, panels, map styles and map layers for the caller, from every module's entries and the administrator's, the caller's groups' and the user's changes",
  args: [],
  flags: [],
};
