import type { CmdReturn, Command } from '@ein/client';
import { collectUnknownFlags, parseArgs, reportUnknownFlags } from '@ein/client';
import { MOD_PATH, WWW_PATH } from '@ein/paths';
import { encodeHex } from '@std/encoding/hex';
import { toText } from '@std/streams/to-text';
import { installationLicences, type ModulePackages } from '@ui/licences';
import { buildModuleUi, type BuildOutcome, storedLicencesKey, writeLicencesFile, writeUiManifest } from '@ui/module-build';

type ModJson = { name?: string; imports?: Record<string, string>; ui?: { routes?: Record<string, string> } };

const readText = async (cmd: Command, path: string): Promise<string | undefined> => {
  try {
    const handle = await cmd.sys.vfs.open(cmd.access, path, { mode: 'r' });
    try {
      return await toText(handle.readable);
    } finally {
      await handle.close();
    }
  } catch {
    return undefined;
  }
};

const readModJson = async (cmd: Command, path: string): Promise<ModJson | undefined> => {
  const text = await readText(cmd, `${path}/mod.json`);
  try {
    return text === undefined ? undefined : JSON.parse(text) as ModJson;
  } catch {
    return undefined;
  }
};

/**
 * Store the installation's third-party notices: the image's, served with the shell, and the
 * packages the installed modules import that core's do not (`installationLicences`). Stored ones
 * made from the same shell notices and imports are kept, and none are written where no shell is
 * served. Returns why they could not be made, or the packages left without a licence text.
 */
const storeLicences = async (cmd: Command, modules: ModulePackages[]): Promise<{ error?: string; missing?: string[] }> => {
  const coreText = await readText(cmd, `${cmd.env.WWW_PATH || WWW_PATH}/ui/public/licences.txt`);
  if (coreText === undefined) return {};
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([coreText, modules])));
  const key = encodeHex(new Uint8Array(digest));
  if (await storedLicencesKey(cmd) === key) return {};
  try {
    const { text, missing } = await installationLicences(coreText, modules);
    await writeLicencesFile(cmd, text, key);
    return { missing };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
};

export const uiBuild = async (cmd: Command): CmdReturn => {
  const unknown: string[] = [];
  const flags = parseArgs(cmd.args, { boolean: ['all', 'help'], unknown: collectUnknownFlags(unknown) });
  if (await reportUnknownFlags(cmd, unknown)) return 1;
  if (flags.help || (!flags.all && flags._.length === 0)) {
    await cmd.writeLn(
      "usage: ui-build <module>... | --all\nBundle modules' routes (mod.json ui.routes) into /var/cache/ui, unless unchanged since the last build,\n" +
        "and write the installation's third-party notices there, with the installed modules' own packages.",
    );
    return flags.help ? 0 : 1;
  }

  const modulesPath = cmd.env.MOD_PATH || MOD_PATH;
  const installed = (await cmd.sys.vfs.children(cmd.access, modulesPath)).map((child) => child.name).sort();
  const withUi: string[] = [];
  const packages: ModulePackages[] = [];
  for (const name of installed) {
    const modJson = await readModJson(cmd, `${modulesPath}/${name}`);
    if (modJson?.ui?.routes) withUi.push(name);
    const specifiers = Object.values(modJson?.imports ?? {}).filter((target) => /^(npm|jsr):/.test(target)).sort();
    packages.push({ name, specifiers });
  }

  const wanted = flags.all ? withUi : flags._.map(String);
  const outcomes: Record<string, BuildOutcome> = {};
  for (const name of wanted) {
    outcomes[name] = withUi.includes(name)
      ? await buildModuleUi(cmd, `${modulesPath}/${name}`)
      : { state: 'failed', error: installed.includes(name) ? 'mod.json has no ui.routes' : 'not installed' };
  }
  const licences = await storeLicences(cmd, packages);
  // A module whose path another already has is left out of the manifest, built or not.
  const { conflicts } = await writeUiManifest(cmd, withUi);
  for (const [name, error] of Object.entries(conflicts)) outcomes[name] = { state: 'failed', error };

  const failed = Object.values(outcomes).some((outcome) => outcome.state === 'failed') || licences.error !== undefined;
  // Failures go to stderr in either mode: it is what a caller of a failed command is shown.
  for (const [name, outcome] of Object.entries(outcomes)) {
    if (outcome.state === 'failed') await cmd.writeError(`ui-build: ${name}: ${outcome.error}\n`);
  }
  if (licences.error) await cmd.writeError(`ui-build: third-party notices: ${licences.error}\n`);
  if (licences.missing?.length) await cmd.writeError(`ui-build: no licence text for ${licences.missing.join(', ')}\n`);
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
  description:
    "Bundle modules' pages into /var/cache/ui for the Web UI to load, unless unchanged since the last build, and write the installation's third-party notices there",
  args: [{ name: 'module', type: 'string' as const, description: 'Module to build; repeatable', variadic: true }],
  flags: [{ name: 'all', type: 'bool' as const, description: 'Every installed module with pages, and forget the bundles of those gone' }],
};
