import type { CmdReturn, Command } from '@ein/client';
import { collectUnknownFlags, parseArgs, reportUnknownFlags } from '@ein/client';
import { LIB_PATH } from '@ein/paths';
import { toText } from '@std/streams/to-text';

const ICON_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Where the built shell keeps a Tabler icon: `name` outline, `name-filled` filled. */
const iconPath = (libPath: string, name: string): string => {
  const filled = name.endsWith('-filled');
  return `${libPath}/ui/ui/icons/tabler/${filled ? 'filled' : 'outline'}/${filled ? name.slice(0, -'-filled'.length) : name}.svg`;
};

/**
 * Tabler icons by name, as SVG markup — many in one answer, which is what the browser asks
 * for: a page names twenty at once, and twenty requests of their own each wait their turn for
 * one of the browser's six connections behind whatever the page is downloading.
 */
export const uiIcons = async (cmd: Command): CmdReturn => {
  const unknown: string[] = [];
  const flags = parseArgs(cmd.args, { boolean: ['help'], unknown: collectUnknownFlags(unknown) });
  if (await reportUnknownFlags(cmd, unknown)) return 1;
  const names = [...new Set(flags._.map(String))];
  if (flags.help || names.length === 0) {
    await cmd.writeLn('usage: ui-icons <name>...\nTabler icons by name (map-pin, heart-filled) as SVG; null for a name there is none of.');
    return flags.help ? 0 : 1;
  }

  const libPath = cmd.env.LIB_PATH || LIB_PATH;
  const icons: Record<string, string | null> = Object.fromEntries(
    await Promise.all(names.map(async (name): Promise<[string, string | null]> => {
      if (!ICON_NAME.test(name)) return [name, null];
      try {
        const handle = await cmd.sys.vfs.open(cmd.access, iconPath(libPath, name), { mode: 'r' });
        try {
          return [name, await toText(handle.readable)];
        } finally {
          await handle.close();
        }
      } catch {
        return [name, null];
      }
    })),
  );

  if (cmd.json) {
    await cmd.writeJSON(icons);
    return 0;
  }
  for (const [name, svg] of Object.entries(icons)) await cmd.writeLn(`${name}: ${svg === null ? 'none' : `${svg.length} bytes`}`);
  return 0;
};

uiIcons.spec = {
  name: 'ui-icons',
  effect: 'read' as const,
  description: 'Tabler icons by name, as SVG markup, for the web UI',
  args: [{ name: 'name', type: 'string' as const, description: 'Icon name: map-pin, heart-filled', variadic: true }],
  flags: [],
};
