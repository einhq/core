/**
 * mod outdated — the installed modules `mod install` fetched, each beside what updating it would
 * take: for one installed at a release, the newest release this core can run, as `mod install`
 * takes it without a ref; for one installed at a branch or another tag, that ref's commit now. One
 * installed at a commit stays there and is left out, as are the deployment's modules.
 *
 * A module is behind when that is another commit and, from a release, a higher version, so one
 * installed from its branch past the newest release is not behind it. Every repository is asked at
 * once, and one that does not answer is named rather than failing the others. Names narrow the
 * list to those modules.
 */

import { join } from '@std/path';
import { greaterThan, tryParse } from '@std/semver';
import type { ModuleInstall, ModuleOutdated, OutdatedModule } from '../../../../lib/api/mod.ts';
import { MOD_PATH } from '../../../../lib/paths.ts';
import { fetchFile, fetchRefs, findRelease, parseRepository, releases, resolveRef, type Tokens } from '../../../../modules/forge.ts';
import { readInstallRecord } from '../../../../modules/install.ts';
import { checkCoreApi, type ModuleManifest, readManifests } from '../../../../modules/mod.ts';
import { mayUseModule } from '../../../../modules/audience.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';
import { FORGE_TIMEOUT_MS, moduleSources, within } from './sources.ts';

const short = (commit: string): string => commit.slice(0, 9);

/** A release's tag, `v<version>`, as `mod install` records a module installed without a ref. */
const isRelease = (ref: string): boolean => {
  const version = ref.startsWith('v') ? tryParse(ref.slice(1)) : undefined;
  return version !== undefined && !version.prerelease?.length;
};

const versionOf = (manifest: Partial<ModuleManifest> | undefined): string | undefined => typeof manifest?.version === 'string' ? manifest.version : undefined;

const readManifest = async (cmd: Command, repository: NonNullable<ReturnType<typeof parseRepository>>, ref: string, tokens: Tokens) => {
  const text = await fetchFile(repository, ref, 'mod.json', tokens, within(cmd, FORGE_TIMEOUT_MS));
  try {
    return text === undefined ? undefined : JSON.parse(text) as Partial<ModuleManifest>;
  } catch {
    return undefined;
  }
};

/** What updating one installed module would take, and whether it moves it on. Throws when its repository does not answer. */
const check = async (cmd: Command, name: string, version: string | null, record: ModuleInstall, tokens: Tokens): Promise<OutdatedModule> => {
  const repository = parseRepository(record.repository);
  if (!repository) throw new Error(`not a repository's address: ${record.repository}`);
  const refs = await fetchRefs(repository, tokens, within(cmd, FORGE_TIMEOUT_MS));
  const release = isRelease(record.ref);
  const target = release ? record.repository : `${record.repository}@${record.ref}`;

  let latest = resolveRef(refs, release ? undefined : record.ref);
  if (!latest) throw new Error(`${record.repository} has no branch or tag '${record.ref}' any more`);
  let latestVersion = latest.commit === record.commit ? version ?? undefined : undefined;
  if (latest.commit !== record.commit) {
    let manifest = await readManifest(cmd, repository, latest.ref, tokens);
    // A newest release written for another module API gives way to the newest this core runs, as in `mod install`.
    if (release && manifest && checkCoreApi(manifest as ModuleManifest).errors.length > 0) {
      const all = releases(refs);
      const older = await findRelease<ModuleManifest>(
        repository,
        all.slice(all.findIndex((each) => each.tag === latest!.ref) + 1),
        tokens,
        (each) => checkCoreApi(each).errors.length === 0,
        within(cmd, FORGE_TIMEOUT_MS),
      );
      if (older) {
        latest = { ref: older.release.tag, commit: older.release.commit };
        manifest = older.manifest;
      }
    }
    latestVersion = versionOf(manifest);
  }

  const [published, installed] = [tryParse(latestVersion ?? ''), tryParse(version ?? '')];
  const behind = latest.commit !== record.commit && (!release || !published || !installed || greaterThan(published, installed));
  return {
    name,
    version,
    ref: record.ref,
    commit: record.commit,
    target,
    latest: { ref: latest.ref, commit: latest.commit, ...(latestVersion ? { version: latestVersion } : {}) },
    behind,
  };
};

/** One line for a module that is behind: what it is now, and what updating takes it to. */
const line = (module: OutdatedModule): string => {
  const from = module.version ?? short(module.commit);
  const to = module.latest.version && module.latest.version !== module.version ? module.latest.version : short(module.latest.commit);
  return `${module.name} ${from} → ${to} (${module.latest.ref})\n`;
};

export const modOutdated = async (cmd: Command): CmdReturn => {
  const names = cmd.args.filter((arg) => !arg.startsWith('-'));
  const modulesPath = cmd.env.MOD_PATH || MOD_PATH;
  const { tokens } = await moduleSources(cmd);

  const candidates: { name: string; version: string | null; record: ModuleInstall }[] = [];
  for (const [name, manifest] of await readManifests(cmd.sys.vfs, cmd.access, modulesPath)) {
    if (names.length > 0 && !names.includes(name)) continue;
    if (!await mayUseModule(cmd.sys.vfs, cmd.access, name)) continue;
    const record = await readInstallRecord(cmd.sys.vfs, cmd.access, join(modulesPath, name));
    if (!record || record.ref === record.commit) continue;
    candidates.push({ name, version: manifest.version ?? null, record });
  }
  candidates.sort((a, b) => a.name.localeCompare(b.name));

  const failed: ModuleOutdated['failed'] = [];
  const checked = await Promise.all(candidates.map(async ({ name, version, record }) => {
    try {
      return await check(cmd, name, version, record, tokens);
    } catch (error) {
      failed.push({ name, reason: error instanceof Error ? error.message : String(error) });
      return undefined;
    }
  }));
  const modules = checked.filter((module) => module !== undefined);

  if (cmd.json) {
    await cmd.writeJSON({ modules, failed } satisfies ModuleOutdated);
    return failed.length > 0 && modules.length === 0 ? 1 : 0;
  }

  for (const { name, reason } of failed) await cmd.writeError(`mod outdated: ${name}: ${reason}\n`);
  const behind = modules.filter((module) => module.behind);
  for (const module of behind) await cmd.write(line(module));
  if (behind.length === 0 && modules.length > 0) await cmd.write(modules.length === 1 ? `${modules[0].name} is up to date\n` : 'Every module is up to date\n');
  if (modules.length === 0 && failed.length === 0) await cmd.write('No module installed by mod install to check\n');
  return failed.length > 0 && modules.length === 0 ? 1 : 0;
};

modOutdated.spec = {
  name: 'mod-outdated',
  effect: 'read' as const,
  description: 'The installed modules with a newer release, or a newer commit of the branch or tag they were installed from, than the one installed',
  args: [
    {
      name: 'names',
      type: 'string' as const,
      variadic: true,
      description: 'Modules to check; every module mod install fetched when none',
    },
  ],
};
