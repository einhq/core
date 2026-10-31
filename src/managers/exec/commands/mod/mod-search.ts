/**
 * mod search — the published modules: every `module-*` repository of each `CFG_MODULE_SOURCES`
 * entry, with what `mod install <name>` would take — its newest release, or when that asks for a
 * module API this core does not provide, the newest that asks for one it does, or its default
 * branch when it has none: the version and module API in its `mod.json`, and its commit, which says
 * whether an installed module is behind it. A newest release passed over is named beside it.
 *
 * Every source is asked at once, and one that does not answer is named rather than failing the
 * others. Words narrow the list to the modules whose name or description holds each of them.
 */

import { join } from '@std/path';
import { canParse, greaterThan, parse, parseRange, satisfies, tryParse } from '@std/semver';
import type { ModuleSearch, PublishedModule } from '../../../../lib/api/mod.ts';
import { MOD_PATH } from '../../../../lib/paths.ts';
import { fetchFile, fetchRefs, findRelease, type ListedRepository, listModuleRepositories, moduleNameOf, releases } from '../../../../modules/forge.ts';
import { readInstallRecord } from '../../../../modules/install.ts';
import { checkCoreApi, MODULE_API_VERSION, type ModuleManifest, readManifests } from '../../../../modules/mod.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';
import { FORGE_TIMEOUT_MS, moduleSources, within } from './sources.ts';

/** Whether this core provides the module API `coreApi` asks for; nothing when it names none that parses. */
const compatibleWith = (coreApi: string | undefined): boolean | undefined => {
  if (!coreApi) return undefined;
  try {
    return satisfies(parse(MODULE_API_VERSION), parseRange(coreApi));
  } catch {
    return undefined;
  }
};

const versionOf = (manifest: Partial<ModuleManifest> | undefined) => typeof manifest?.version === 'string' ? manifest.version : undefined;
const coreApiOf = (manifest: Partial<ModuleManifest> | undefined) => typeof manifest?.coreApi === 'string' ? manifest.coreApi : undefined;

/**
 * What a listed repository's release `mod install` would take holds, or its default branch when it
 * has none, as far as it answers.
 */
const describe = async (cmd: Command, repository: ListedRepository, tokens: Parameters<typeof fetchRefs>[1]): Promise<PublishedModule> => {
  const refs = await fetchRefs(repository, tokens, within(cmd, FORGE_TIMEOUT_MS)).catch(() => undefined);
  const all = refs ? releases(refs) : [];
  let release = all[0];
  let manifest = await fetchFile(repository, release?.tag ?? repository.branch, 'mod.json', tokens, within(cmd, FORGE_TIMEOUT_MS))
    .then((text) => text === undefined ? undefined : JSON.parse(text) as Partial<ModuleManifest>)
    .catch(() => undefined);
  let newest: PublishedModule['newest'];
  if (release && compatibleWith(coreApiOf(manifest)) === false) {
    const older = await findRelease<ModuleManifest>(repository, all.slice(1), tokens, (each) => checkCoreApi(each).errors.length === 0, within(cmd, FORGE_TIMEOUT_MS))
      .catch(() => undefined);
    if (older) {
      newest = { release: release.tag, ...(versionOf(manifest) ? { version: versionOf(manifest) } : {}), coreApi: coreApiOf(manifest)! };
      ({ release, manifest } = older);
    }
  }
  const version = versionOf(manifest);
  const coreApi = coreApiOf(manifest);
  const commit = release?.commit ?? refs?.refs.get(`refs/heads/${repository.branch}`) ?? refs?.head;
  const compatible = compatibleWith(coreApi);
  return {
    name: moduleNameOf(repository),
    repository: repository.repository,
    source: repository.url,
    description: repository.description || (typeof manifest?.description === 'string' ? manifest.description : ''),
    branch: repository.branch,
    ...(release ? { release: release.tag } : {}),
    ...(commit ? { commit } : {}),
    ...(version ? { version } : {}),
    ...(coreApi ? { coreApi } : {}),
    ...(compatible !== undefined ? { compatible } : {}),
    ...(newest ? { newest } : {}),
  };
};

/**
 * Whether `mod install <name>` would move what is installed from the same repository on: it takes
 * another commit, and from a release, a higher version than the installed one, so a module
 * installed from its branch past the newest release is not behind it.
 */
const behind = (module: PublishedModule, mine: { version?: string; commit?: string }): boolean => {
  if (!module.commit || mine.commit === module.commit) return false;
  const [published, installed] = [tryParse(module.version ?? ''), tryParse(mine.version ?? '')];
  return !module.release || !published || !installed || greaterThan(published, installed);
};

/** Whether a module's name or description holds every word. */
const matches = (module: PublishedModule, words: string[]): boolean => {
  const text = `${module.name} ${module.description}`.toLowerCase();
  return words.every((word) => text.includes(word.toLowerCase()));
};

/** One line for a published module: what is installed of it, beside what is published. */
const line = (module: PublishedModule, installed: Map<string, { version?: string; repository?: string; commit?: string }>): string => {
  const mine = installed.get(module.name);
  let state = '';
  if (mine) {
    state = mine.repository && mine.repository !== module.repository
      ? ` [installed from ${mine.repository}]`
      : !mine.repository
      ? ` [the deployment's${mine.version ? ` ${mine.version}` : ''}]`
      : behind(module, mine)
      ? ` [installed ${mine.commit!.slice(0, 9)}, ${module.release ?? module.commit!.slice(0, 9)} published]`
      : ' [installed]';
  }
  const api = module.compatible === false
    ? ` (needs core API ${module.coreApi}, this is ${MODULE_API_VERSION})`
    : module.newest
    ? ` (${module.newest.version ?? module.newest.release} needs core API ${module.newest.coreApi}, this is ${MODULE_API_VERSION})`
    : '';
  return `${module.name}${module.version ? ` ${module.version}` : ''}${state}${api}\n  ${module.description ? `${module.description}\n  ` : ''}${module.repository}\n`;
};

export const modSearch = async (cmd: Command): CmdReturn => {
  const words = cmd.args.filter((arg) => !arg.startsWith('-'));
  const { sources, problems, tokens } = await moduleSources(cmd);
  const failed: ModuleSearch['failed'] = problems.map((reason) => ({ source: 'CFG_MODULE_SOURCES', reason }));

  const listed = await Promise.all(sources.map(async (source) => {
    try {
      return await listModuleRepositories(source, tokens, within(cmd, FORGE_TIMEOUT_MS));
    } catch (error) {
      failed.push({ source: source.url, reason: error instanceof Error ? error.message : String(error) });
      return [];
    }
  }));
  const modules = (await Promise.all(listed.flat().map((repository) => describe(cmd, repository, tokens)))).filter((module) => matches(module, words));

  if (cmd.json) {
    await cmd.writeJSON({ modules, failed } satisfies ModuleSearch);
    if (failed.length === 0 || modules.length > 0 || sources.length === 0) return 0;
    // Failing, the answer is not read: why goes where the failure is.
    for (const { source, reason } of failed) await cmd.writeError(`mod search: ${source}: ${reason}\n`);
    return 1;
  }

  for (const { source, reason } of failed) await cmd.writeError(`mod search: ${source}: ${reason}\n`);
  if (sources.length === 0) {
    await cmd.writeError('mod search: no module sources: CFG_MODULE_SOURCES is empty\n');
    return 1;
  }

  const modulesPath = cmd.env.MOD_PATH || MOD_PATH;
  const installed = new Map<string, { version?: string; repository?: string; commit?: string }>();
  for (const [name, manifest] of await readManifests(cmd.sys.vfs, cmd.access, modulesPath)) {
    const record = await readInstallRecord(cmd.sys.vfs, cmd.access, join(modulesPath, name));
    installed.set(name, { version: canParse(manifest.version ?? '') ? manifest.version : undefined, repository: record?.repository, commit: record?.commit });
  }

  if (modules.length === 0) {
    await cmd.write(words.length > 0 ? 'No published module matches\n' : 'No published modules\n');
  }
  for (const module of modules) await cmd.write(line(module, installed));
  return failed.length > 0 && modules.length === 0 ? 1 : 0;
};

modSearch.spec = {
  name: 'mod-search',
  effect: 'read' as const,
  description: 'The published modules: each module-* repository of the module sources (CFG_MODULE_SOURCES), with its version and whether it is installed',
  args: [
    {
      name: 'words',
      type: 'string' as const,
      variadic: true,
      description: 'Words the name or description must hold',
    },
  ],
};
