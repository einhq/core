/**
 * mod install — fetch modules from their repositories and set them up.
 *
 * A module is named by its repository's address, `https://host/owner/module-x`, or by its name,
 * which the first of `CFG_MODULE_SOURCES` to have `module-<name>` answers; either may end in
 * `@<branch, tag or commit>`, and without one the newest release is taken — the highest `v<version>`
 * tag, or when its `mod.json` asks for a module API this core does not provide, the highest whose
 * does — or the default branch when there is none; a commit's id may be cut short, and is recorded
 * whole. The tree at that commit is unpacked beside the installed
 * modules (`MOD_INSTALL_PATH`), checked, renamed into place and linked into `MOD_PATH`, the way
 * boot links them.
 *
 * Before anything is replaced: the module must be no deployment's (a name the deployment mounts
 * runs from there), it must be written for this core's module API, and its exports and pages must
 * hold. A dependency that is not installed is installed first, from the module's own organisation
 * and else from the sources, at its newest release in the range the module asks for; one installed
 * at a version the module does not accept refuses it.
 * An update must be accepted by every installed module that depends on it, unless `--force`.
 *
 * Then each module put in place is set up, dependencies first, and its services started — or
 * restarted, on an update — and every module depending on an updated one, however indirectly, is
 * set up again with its running services restarted, so nothing keeps running the code replaced.
 *
 * Boot installs the modules the deployment asks for (`INSTALL_MODULES`) with `--missing`, which
 * leaves any module installed already as it is without asking a forge, and `--no-setup`, which
 * leaves the setting up to boot's own `mod setup --all` and the starting of services to its last
 * step.
 */

import { basename, join } from '@std/path';
import { canParse, parse, parseRange, satisfies } from '@std/semver';
import { ulid } from '@std/ulid';
import type { InstalledModule, ModuleInstall, ModuleInstallResult, ServiceEntry } from '../../../../lib/api/mod.ts';
import { ADMIN_ACCESS } from '../../../../lib/access/mod.ts';
import { groupGid } from '../../../../lib/auth/member-gids.ts';
import { writeModuleGroups } from '../../../../modules/audience.ts';
import { parseArgs } from '../../../../lib/args/mod.ts';
import { DEV_MODULES_PATH, MOD_INSTALL_PATH, MOD_PATH } from '../../../../lib/paths.ts';
import {
  ABBREVIATED_COMMIT,
  fetchArchive,
  fetchCommit,
  fetchRefs,
  findRelease,
  ForgeError,
  type InstallTarget,
  MODULE_NAME,
  MODULE_REPOSITORY_PREFIX,
  moduleNameOf,
  type ModuleSource,
  parseInstallTarget,
  type Refs,
  releases,
  type Repository,
  repositoryOf,
  resolveRef,
  type Tokens,
} from '../../../../modules/forge.ts';
import { readInstallRecord, REPLACED_PREFIX, STAGING_PREFIX, unpackArchive, writeInstallRecord } from '../../../../modules/install.ts';
import { checkCoreApi, checkExports, checkUi, MODULE_API_VERSION, type ModuleManifest, readManifests, readModJson, resolveSetupOrder } from '../../../../modules/mod.ts';
import { NODE_TYPE_DIRECTORY } from '../../../../vfs/types/directory.ts';
import { NODE_TYPE_SOFTLINK } from '../../../../vfs/types/softlink.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';
import { setupOne } from './mod-setup.ts';
import { rebuildModulePages } from './module-pages.ts';
import { ARCHIVE_TIMEOUT_MS, FORGE_TIMEOUT_MS, moduleSources, within } from './sources.ts';

/** Why one module cannot be installed, said as it is. */
class InstallError extends Error {}

type Run = {
  cmd: Command;
  sources: ModuleSource[];
  tokens: Tokens;
  /** `MOD_INSTALL_PATH`: where installed modules live. */
  store: string;
  /** `MOD_PATH`: where every module is linked. */
  modules: string;
  /** `DEV_MODULES_PATH`: the deployment's modules. */
  deployment: string;
  force: boolean;
  /** Only what is not installed: a module installed, at any version, is left as it is. */
  missing: boolean;
  /** What this run put in place, dependencies first. */
  installed: InstalledModule[];
  /** The modules being installed, for a dependency that leads back to one of them. */
  visiting: Set<string>;
};

const short = (commit: string): string => commit.slice(0, 9);

const say = async (run: Run, line: string): Promise<void> => {
  if (!run.cmd.json) await run.cmd.write(`${line}\n`);
};

/** Whether `version` is in `range`; a version or range that does not parse is not held against it. */
const accepts = (version: string | undefined, range: string): boolean => {
  if (!version || !canParse(version)) return true;
  try {
    return satisfies(parse(version), parseRange(range));
  } catch {
    return true;
  }
};

/** Make `path` and the directories above it. */
const ensurePath = async (cmd: Command, path: string): Promise<void> => {
  let parent = '/';
  for (const segment of path.split('/').filter(Boolean)) {
    await cmd.sys.vfs.ensure(cmd.access, NODE_TYPE_DIRECTORY, parent, segment, { props: { mode: 0o755 } });
    parent = join(parent, segment);
  }
};

/** A published module's repository and refs: the first source with `module-<name>`. */
const findPublished = async (run: Run, name: string): Promise<{ repository: Repository; refs: Refs }> => {
  if (run.sources.length === 0) throw new InstallError(`no module sources to find '${name}' in: CFG_MODULE_SOURCES is empty; name its repository instead`);
  const reasons: string[] = [];
  for (const source of run.sources) {
    const repository = repositoryOf(source, `${MODULE_REPOSITORY_PREFIX}${name}`);
    try {
      return { repository, refs: await fetchRefs(repository, run.tokens, within(run.cmd, FORGE_TIMEOUT_MS)) };
    } catch (error) {
      if (!(error instanceof ForgeError)) throw error;
      reasons.push(error.message);
    }
  }
  throw new InstallError(`no module source has '${name}': ${reasons.join('; ')}`);
};

/** Where `target` is, and its refs. A dependency, named, is looked for beside the module needing it first. */
const locate = async (run: Run, target: InstallTarget, near?: Repository): Promise<{ repository: Repository; refs: Refs }> => {
  if (target.kind === 'repository') {
    try {
      return { repository: target.repository, refs: await fetchRefs(target.repository, run.tokens, within(run.cmd, FORGE_TIMEOUT_MS)) };
    } catch (error) {
      if (error instanceof ForgeError) throw new InstallError(error.message);
      throw error;
    }
  }
  if (near) {
    const repository = repositoryOf(near, `${MODULE_REPOSITORY_PREFIX}${target.name}`);
    try {
      return { repository, refs: await fetchRefs(repository, run.tokens, within(run.cmd, FORGE_TIMEOUT_MS)) };
    } catch (error) {
      if (!(error instanceof ForgeError)) throw error;
    }
  }
  return await findPublished(run, target.name);
};

/** The commit a short id names, recorded as its whole id, as a whole id given is; nothing when it names none. */
const resolveAbbreviated = async (run: Run, repository: Repository, ref?: string): Promise<{ ref: string; commit: string } | undefined> => {
  if (!ref || !ABBREVIATED_COMMIT.test(ref)) return undefined;
  try {
    const commit = await fetchCommit(repository, ref, run.tokens, within(run.cmd, FORGE_TIMEOUT_MS));
    return commit ? { ref: commit, commit } : undefined;
  } catch (error) {
    if (error instanceof ForgeError) throw new InstallError(error.message);
    throw error;
  }
};

/**
 * The newest release older than the one `taken` names, in `range` when there is one, whose
 * `mod.json` asks for a module API this core provides; nothing when none does.
 */
const olderCompatible = async (run: Run, repository: Repository, refs: Refs, taken: string, range?: string): Promise<string | undefined> => {
  const all = releases(refs);
  const at = all.findIndex((release) => release.tag === taken);
  const candidates = at < 0 ? [] : all.slice(at + 1).filter((release) => range === undefined || accepts(release.version, range));
  try {
    const found = await findRelease<ModuleManifest>(
      repository,
      candidates,
      run.tokens,
      (manifest) => checkCoreApi(manifest).errors.length === 0,
      within(run.cmd, FORGE_TIMEOUT_MS),
    );
    return found?.release.tag;
  } catch (error) {
    if (error instanceof ForgeError) throw new InstallError(error.message);
    throw error;
  }
};

/** Whether `MOD_PATH/<name>` is the link to the installed module of that name. */
const linksTo = async (run: Run, name: string): Promise<boolean> => {
  try {
    return (await run.cmd.sys.vfs.get(ADMIN_ACCESS, join(run.modules, name), { follow: false })).props.softlink === join(run.store, name);
  } catch {
    return false;
  }
};

/** Refuses a name the deployment provides: its module runs, whatever is installed. */
const refuseDeployed = async (run: Run, name: string): Promise<void> => {
  const deployed = join(run.deployment, name);
  if (await run.cmd.sys.vfs.exists(run.cmd.access, join(deployed, 'mod.json'))) {
    throw new InstallError(`'${name}' is one of the deployment's modules (${deployed}), which runs instead`);
  }
};

/** The installed modules that depend on `name`, with the range each accepts. */
const dependentsOf = async (run: Run, name: string): Promise<[string, string][]> =>
  [...(await readManifests(run.cmd.sys.vfs, run.cmd.access, run.modules)).values()]
    .filter((manifest) => manifest.name !== name && manifest.dependencies?.[name] !== undefined)
    .map((manifest) => [manifest.name, manifest.dependencies![name]]);

/**
 * Put one module in place, its missing dependencies first; nothing when the commit asked for is
 * the one installed already. Without a ref, `range` picks the newest release in it, and a release
 * written for another module API gives way to the newest older one written for this core's.
 * `located` is the repository and its refs when they are known already. Throws an `InstallError`
 * saying why it cannot be installed.
 */
const installTarget = async (
  run: Run,
  target: InstallTarget,
  near?: Repository,
  range?: string,
  located?: { repository: Repository; refs: Refs },
): Promise<InstalledModule | undefined> => {
  const { cmd } = run;
  const vfs = cmd.sys.vfs;
  // The module it is named for, which the repository's mod.json confirms once it is fetched.
  const expected = target.kind === 'name' ? target.name : moduleNameOf(target.repository);
  if (run.missing && await vfs.exists(cmd.access, join(run.modules, expected, 'mod.json'))) {
    await say(run, `${expected} is installed; left as it is`);
    return undefined;
  }
  await refuseDeployed(run, expected);
  const { repository, refs } = located ?? await locate(run, target, near);
  const resolved = resolveRef(refs, target.ref, range) ?? await resolveAbbreviated(run, repository, target.ref);
  if (!resolved) {
    throw new InstallError(
      target.ref ? `${repository.repository} has no branch, tag or commit '${target.ref}'` : `${repository.repository} has no release and no default branch`,
    );
  }

  const current = await readInstallRecord(vfs, cmd.access, join(run.store, expected));
  if (!run.force && current?.repository === repository.repository && current.commit === resolved.commit && await linksTo(run, expected)) {
    await say(run, `${expected} is installed at ${short(resolved.commit)} (${resolved.ref}) already`);
    return undefined;
  }

  await say(run, `Fetching ${repository.repository} at ${resolved.ref} (${short(resolved.commit)})...`);
  await ensurePath(cmd, run.store);
  const staging = join(run.store, `${STAGING_PREFIX}${ulid().toLowerCase()}`);
  await vfs.create(cmd.access, NODE_TYPE_DIRECTORY, run.store, basename(staging), { props: { mode: 0o755 } });
  let staged = true;
  try {
    let unpacked;
    try {
      unpacked = await unpackArchive(vfs, cmd.access, await fetchArchive(repository, resolved.commit, run.tokens, within(cmd, ARCHIVE_TIMEOUT_MS)), staging);
    } catch (error) {
      if (error instanceof ForgeError) throw new InstallError(error.message);
      throw new InstallError(`${repository.repository} at ${short(resolved.commit)}: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const skipped of unpacked.skipped) await cmd.writeError(`mod install: ${skipped}\n`);

    const manifest = await readModJson(vfs, cmd.access, staging);
    if (!manifest) throw new InstallError(`${repository.repository} at ${short(resolved.commit)} has no mod.json at its top: not a module`);
    const name = manifest.name;
    if (typeof name !== 'string' || !MODULE_NAME.test(name)) {
      throw new InstallError(`${repository.repository}: its mod.json names no module, or one no directory can be named: ${name}`);
    }
    if (target.kind === 'name' && name !== target.name) throw new InstallError(`${repository.repository} holds the module '${name}', not '${target.name}'`);
    if (run.visiting.has(name)) throw new InstallError(`'${name}' depends on itself, through ${[...run.visiting].join(' -> ')}`);

    await refuseDeployed(run, name);

    const installedPath = join(run.store, name);
    const linkPath = join(run.modules, name);
    // A link to a module that is gone is replaced; anything else there is not this command's.
    const linked = await linksTo(run, name);
    if (!linked && await vfs.exists(cmd.access, linkPath)) {
      throw new InstallError(`${linkPath} is a module mod install did not put there; mod remove ${name} first`);
    }

    const problems = [
      ...checkCoreApi(manifest).errors,
      ...(await checkExports(vfs, cmd.access, staging, manifest)).errors,
      ...checkUi(manifest).errors,
    ];
    if (problems.length > 0) {
      const older = target.ref === undefined && checkCoreApi(manifest).errors.length > 0 ? await olderCompatible(run, repository, refs, resolved.ref, range) : undefined;
      if (older === undefined) throw new InstallError(problems.join('; '));
      await say(
        run,
        `${[name, manifest.version].filter(Boolean).join(' ')} needs core API ${manifest.coreApi}, and this core provides ${MODULE_API_VERSION}: taking ${older}`,
      );
      return await installTarget(run, { ...target, ref: older }, near, range, { repository, refs });
    }

    run.visiting.add(name);
    try {
      for (const [dependency, range] of Object.entries(manifest.dependencies ?? {})) {
        let version = (await readModJson(vfs, cmd.access, join(run.modules, dependency)))?.version;
        if (version === undefined) {
          await say(run, `${name} needs ${dependency} ${range}, which is not installed`);
          version = (await installTarget(run, { kind: 'name', name: dependency }, repository, range))?.version ?? undefined;
          version ??= (await readModJson(vfs, cmd.access, join(run.store, dependency)))?.version;
        }
        if (!accepts(version, range)) {
          throw new InstallError(`${name} needs ${dependency} ${range}, and ${dependency} ${version} is installed: mod install ${dependency} updates it`);
        }
      }
    } finally {
      run.visiting.delete(name);
    }

    if (!run.force) {
      const refusing = (await dependentsOf(run, name)).filter(([, range]) => !accepts(manifest.version, range));
      if (refusing.length > 0) {
        const needs = refusing.map(([dependent, range]) => `${dependent} needs ${name} ${range}`).join(', ');
        throw new InstallError(`${needs}, and this is ${name} ${manifest.version}: --force installs it all the same`);
      }
    }

    const record: ModuleInstall = { repository: repository.repository, ref: resolved.ref, commit: resolved.commit, at: new Date().toISOString() };
    await writeInstallRecord(vfs, cmd.access, staging, record);

    // The new tree takes the name before the old one is removed, so the name always holds a whole module.
    const updated = await vfs.exists(cmd.access, installedPath, { follow: false });
    const replaced = `${REPLACED_PREFIX}${name}-${ulid().toLowerCase()}`;
    if (updated) await vfs.rename(cmd.access, run.store, name, run.store, replaced, { failIfExists: true });
    await vfs.rename(cmd.access, run.store, basename(staging), run.store, name, { failIfExists: true });
    staged = false;
    if (updated) await vfs.unlink(ADMIN_ACCESS, join(run.store, replaced), run.store, { recursive: true });

    if (!linked) {
      await ensurePath(cmd, run.modules);
      if (await vfs.exists(ADMIN_ACCESS, linkPath, { follow: false })) await vfs.unlink(ADMIN_ACCESS, linkPath, run.modules, { readlink: true });
      await vfs.create(ADMIN_ACCESS, NODE_TYPE_SOFTLINK, run.modules, name, { props: { softlink: installedPath } });
    }

    const installed: InstalledModule = { ...record, name, version: manifest.version ?? null, updated };
    run.installed.push(installed);
    await say(run, `${updated ? 'Updated' : 'Installed'} ${[name, manifest.version].filter(Boolean).join(' ')} from ${repository.repository} at ${short(resolved.commit)}`);
    return installed;
  } finally {
    if (staged) {
      try {
        await vfs.unlink(ADMIN_ACCESS, staging, run.store, { recursive: true });
      } catch {
        // Nothing reads a staging directory, and the next install's name is another.
      }
    }
  }
};

/** The names of a module's services, as `mod setup` registers them. */
const servicesOf = async (cmd: Command, name: string): Promise<string[]> => {
  try {
    return (await cmd.sys.vfs.children(cmd.access, join(cmd.env.MOD_PATH || MOD_PATH, name, 'services'))).map((child) => child.name);
  } catch {
    return [];
  }
};

/** Restart services, or start them; one that will not is said and does not fail the install. */
const restartServices = async (cmd: Command, names: string[]): Promise<void> => {
  for (const name of names) {
    const res = await cmd.execute(`service restart ${name}`);
    if (res.code !== 0) await cmd.writeError(`mod install: service ${name} did not restart: ${res.stderr.trim()}\n`);
    else if (!cmd.json) await cmd.write(`  Restarted service '${name}'\n`);
  }
};

/** The services running now. */
const runningServices = async (cmd: Command): Promise<Set<string>> => {
  const res = await cmd.execute('JSON_OUTPUT=1 service-list');
  if (res.code !== 0) return new Set();
  try {
    return new Set((JSON.parse(res.stdout) as ServiceEntry[]).filter((service) => service.enabled && service.status === 'running').map((service) => service.name));
  } catch {
    return new Set();
  }
};

/**
 * Every installed module that depends on one of `changed`, directly or through another, in setup
 * order, leaving out `changed` and `skip`.
 */
const affectedBy = async (cmd: Command, changed: Set<string>, skip: Set<string>): Promise<string[]> => {
  const manifests = await readManifests(cmd.sys.vfs, cmd.access, cmd.env.MOD_PATH || MOD_PATH);
  const reached = new Set(changed);
  const { order } = resolveSetupOrder(manifests);
  for (const name of order) {
    if (Object.keys(manifests.get(name)?.dependencies ?? {}).some((dependency) => reached.has(dependency))) reached.add(name);
  }
  return order.filter((name) => reached.has(name) && !changed.has(name) && !skip.has(name));
};

export const modInstall = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, { boolean: ['force', 'missing', 'no-setup'], string: ['groups'], alias: { f: 'force' } });
  const targets = flags._.map(String);
  if (targets.length === 0) {
    await cmd.writeError('mod install: name a module or its repository\n');
    await cmd.writeError('usage: mod install <name | https://host/owner/module-name>[@ref]... [--groups a,b] [--force] [--missing] [--no-setup]\n');
    return 1;
  }
  const groups = typeof flags.groups === 'string' ? flags.groups.split(',').map((group) => group.trim()).filter(Boolean) : [];
  for (const group of groups) {
    if (await groupGid(cmd.sys.vfs, group) === undefined) {
      await cmd.writeError(`mod install: no group ${group}\n`);
      return 1;
    }
  }

  const { sources, problems, tokens } = await moduleSources(cmd);
  for (const problem of problems) await cmd.writeError(`mod install: CFG_MODULE_SOURCES: ${problem}\n`);

  const run: Run = {
    cmd,
    sources,
    tokens,
    store: cmd.env.MOD_INSTALL_PATH || MOD_INSTALL_PATH,
    modules: cmd.env.MOD_PATH || MOD_PATH,
    deployment: cmd.env.DEV_MODULES_PATH || DEV_MODULES_PATH,
    force: flags.force === true,
    missing: flags.missing === true,
    installed: [],
    visiting: new Set(),
  };

  const failed: string[] = [];
  const fail = async (message: string): Promise<void> => {
    failed.push(message);
    await cmd.writeError(`mod install: ${message}\n`);
  };

  for (const value of targets) {
    const target = parseInstallTarget(value);
    if ('error' in target) {
      await fail(target.error);
      continue;
    }
    try {
      const installed = await installTarget(run, target);
      // Kept to its groups before it is set up, so it is never everyone's on the way.
      if (installed && groups.length > 0) await writeModuleGroups(cmd.sys.vfs, installed.name, groups);
    } catch (error) {
      if (!(error instanceof InstallError)) throw error;
      await fail(error.message);
    }
  }

  // What was put in place runs: set up, dependencies first, with its services started.
  const setUp = flags['no-setup'] === true ? [] : run.installed;
  for (const module of setUp) {
    if (await setupOne(cmd, module.name) !== 0) {
      await fail(`${module.name}: its setup failed (mod list --long says why)`);
      continue;
    }
    await restartServices(cmd, await servicesOf(cmd, module.name));
  }

  // What depends on an updated module set up again, and its running services restarted.
  const updated = new Set(setUp.filter((module) => module.updated).map((module) => module.name));
  if (updated.size > 0) {
    const affected = await affectedBy(cmd, updated, new Set(run.installed.map((module) => module.name)));
    const running = affected.length > 0 ? await runningServices(cmd) : new Set<string>();
    for (const name of affected) {
      await say(run, `${name} depends on what was updated: setting it up again`);
      if (await setupOne(cmd, name) !== 0) await fail(`${name}: its setup failed after the update (mod list --long says why)`);
      await restartServices(cmd, (await servicesOf(cmd, name)).filter((service) => running.has(service)));
    }
  }

  if (setUp.length > 0) await rebuildModulePages(cmd);

  if (cmd.json) await cmd.writeJSON({ ok: failed.length === 0, installed: run.installed, failed } satisfies ModuleInstallResult);
  return failed.length === 0 ? 0 : 1;
};

modInstall.spec = {
  name: 'mod-install',
  admin: true,
  effect: 'write' as const,
  description: 'Install modules from their repositories, or update them, with the dependencies they lack, and set them up',
  args: [
    {
      name: 'module',
      type: 'string' as const,
      variadic: true,
      description:
        'A published module by name (archive), or its repository (https://github.com/einhq/module-archive), either with @branch, @tag or @commit (its id whole, or its first seven characters or more); without one, its newest release (v<version> tag) that this core can run, or its default branch when it has none',
    },
  ],
  flags: [
    {
      name: 'force',
      type: 'bool' as const,
      description: 'Fetch again what is installed at the same commit, and update even when an installed module does not accept the new version',
    },
    { name: 'missing', type: 'bool' as const, description: 'Install only modules not installed at all, leaving an installed one as it is without asking its forge' },
    {
      name: 'groups',
      type: 'string' as const,
      description: "Keep the modules named to these groups, comma-separated, as mod groups does; the dependencies it installs with them are everyone's",
    },
    {
      name: 'no-setup',
      type: 'bool' as const,
      description: 'Put the modules in place without setting them up or starting their services, as boot does before its own mod setup --all',
    },
  ],
};
