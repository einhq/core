import type { CmdReturn, Command } from '@ein/client';
import { collectUnknownFlags, parseArgs, reportUnknownFlags } from '@ein/client';
import { MOD_PATH } from '@ein/paths';
import { toText } from '@std/streams/to-text';
import { buildModuleUi, type BuildOutcome, writeUiManifest } from '@ui/module-build';

type ModJson = { name?: string; ui?: { routes?: Record<string, string> } };

const readModJson = async (cmd: Command, path: string): Promise<ModJson | undefined> => {
  try {
    const handle = await cmd.sys.vfs.open(cmd.access, `${path}/mod.json`, { mode: 'r' });
    try {
      return JSON.parse(await toText(handle.readable)) as ModJson;
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
};

export const uiBuild = async (cmd: Command): CmdReturn => {
  const unknown: string[] = [];
  const flags = parseArgs(cmd.args, { boolean: ['all', 'help'], unknown: collectUnknownFlags(unknown) });
  if (await reportUnknownFlags(cmd, unknown)) return 1;
  if (flags.help || (!flags.all && flags._.length === 0)) {
    await cmd.writeLn(
      "usage: ui-build <module>... | --all\nBundle modules' routes (mod.json ui.routes) into /var/cache/ui, unless unchanged since the last build.",
    );
    return flags.help ? 0 : 1;
  }

  const modulesPath = cmd.env.MOD_PATH || MOD_PATH;
  const installed = (await cmd.sys.vfs.children(cmd.access, modulesPath)).map((child) => child.name).sort();
  const withUi: string[] = [];
  for (const name of installed) {
    if ((await readModJson(cmd, `${modulesPath}/${name}`))?.ui?.routes) withUi.push(name);
  }

  const wanted = flags.all ? withUi : flags._.map(String);
  const outcomes: Record<string, BuildOutcome> = {};
  for (const name of wanted) {
    outcomes[name] = withUi.includes(name)
      ? await buildModuleUi(cmd, `${modulesPath}/${name}`)
      : { state: 'failed', error: installed.includes(name) ? 'mod.json has no ui.routes' : 'not installed' };
  }
  // A module whose path another already has is left out of the manifest, built or not.
  const { conflicts } = await writeUiManifest(cmd, withUi);
  for (const [name, error] of Object.entries(conflicts)) outcomes[name] = { state: 'failed', error };

  const failed = Object.values(outcomes).some((outcome) => outcome.state === 'failed');
  // Failures go to stderr in either mode: it is what a caller of a failed command is shown.
  for (const [name, outcome] of Object.entries(outcomes)) {
    if (outcome.state === 'failed') await cmd.writeError(`ui-build: ${name}: ${outcome.error}\n`);
  }
  if (cmd.json) {
    await cmd.writeJSON({ modules: outcomes });
    return failed ? 1 : 0;
  }
  for (const [name, outcome] of Object.entries(outcomes)) {
    if (outcome.state === 'built') await cmd.writeLn(`${name}: built, ${(outcome.bytes / 1024).toFixed(1)} KB in ${outcome.ms} ms`);
    else if (outcome.state === 'cached') await cmd.writeLn(`${name}: unchanged`);
  }
  if (wanted.length === 0) await cmd.writeLn('no module has pages to build');
  return failed ? 1 : 0;
};

uiBuild.spec = {
  name: 'ui-build',
  effect: 'write' as const,
  description: "Bundle modules' pages into /var/cache/ui for the web UI to load, unless unchanged since the last build",
  args: [{ name: 'module', type: 'string' as const, description: 'Module to build; repeatable', variadic: true }],
  flags: [{ name: 'all', type: 'bool' as const, description: 'Every installed module with pages, and forget the bundles of those gone' }],
};
