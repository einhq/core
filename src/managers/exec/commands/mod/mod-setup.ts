import { DOCS_MODULES_PATH, PIPELINES_PATH, SERVICES_PATH, WWW_PATH } from '../../../../lib/paths.ts';
import { join } from '@std/path';
import { toText } from '@std/streams/to-text';
import { ADMIN_ACCESS } from '../../../../lib/access/mod.ts';
import { registerConfigOptions } from '../../../../lib/config/registry.ts';
import { contributionsOf, registerContributions } from '../../../../lib/contributions/registry.ts';
import { ensureArchiveRoots } from '../../../../lib/contributions/roots.ts';
import { manifestConfigOptions, readManifests, readModJson, resolveSetupOrder, validateManifest } from '../../../../modules/mod.ts';
import { clearCommandLookupCache } from '../../../shell/command-lookup.ts';
import { clearTsCommandCache } from '../../../shell/ts-command-loader.ts';
import { NODE_TYPE_DIRECTORY } from '../../../../vfs/types/directory.ts';
import { parsePipeline } from '../../../pipeline/mod.ts';
import type { Command } from '../../command.ts';
import { CmdReturn } from '../../types.ts';
import { buildPathExportLine } from './path-line.ts';
import { pruneVanishedModules } from './prune.ts';
import { isLinkedEtc, linkModuleFiles } from './module-links.ts';
import { rebuildModulePages } from './module-pages.ts';
import { recordModuleSetup } from '../../../../modules/setup-state.ts';

/**
 * Set up every installed module, dependencies first: a module's setup fails when a dependency is
 * not set up yet.
 */
const setupAll = async (cmd: Command): Promise<number> => {
  // First, so a module that took over a vanished one's service or pipeline name can claim it.
  const pruned = await pruneVanishedModules(cmd);
  const manifests = await readManifests(cmd.sys.vfs, cmd.access, cmd.env.MOD_PATH);
  const { order, cycles } = resolveSetupOrder(manifests);

  for (const cycle of cycles) {
    await cmd.writeError(`mod setup: dependency cycle, skipping: ${cycle.join(' -> ')}\n`);
    for (const name of cycle) recordModuleSetup(name, [`dependency cycle: ${cycle.join(' -> ')}`]);
  }

  const failed: string[] = [];
  for (const name of order) {
    try {
      const code = await setupOne(cmd, name);
      if (code !== 0) {
        failed.push(name);
        await cmd.writeError(`mod setup: module '${name}' failed; continuing with remaining modules\n`);
      }
    } catch (error) {
      failed.push(name);
      const message = error instanceof Error ? error.message : String(error);
      recordModuleSetup(name, [message]);
      await cmd.writeError(`mod setup: module '${name}' failed: ${message}; continuing with remaining modules\n`);
    }
  }

  await rebuildModulePages(cmd);

  if (cmd.json) await cmd.writeJSON({ ok: failed.length === 0 && cycles.length === 0, setup: order, failed, pruned });
  // A module that fails to set up must not take the whole boot with it, but it must be visible.
  return failed.length > 0 || cycles.length > 0 ? 1 : 0;
};

export const modSetup = async (cmd: Command): CmdReturn => {
  const name = cmd.args[0];

  if (name === '--all') return await setupAll(cmd);

  if (!name) {
    await cmd.writeError('mod setup: missing module name\n');
    await cmd.writeError('usage: mod setup <name> | mod setup --all\n');
    return 1;
  }

  const code = await setupOne(cmd, name);
  await rebuildModulePages(cmd);
  if (code === 0 && cmd.json) await cmd.writeJSON({ ok: true });
  return code;
};

/**
 * Set up one module, without rebuilding the modules' pages, which the caller does once for all it
 * sets up. Records how it went; 0 when it went through.
 */
export const setupOne = async (cmd: Command, name: string): Promise<number> => {
  // This module's bins are about to become findable. `$PATH` lookups are memoised with a short
  // TTL, and negative answers are memoised too, so drop them rather than make the caller wait it
  // out for a command that exists now.
  clearCommandLookupCache();

  // An upgrade replaces bins this process may already have loaded. Their staging is keyed on the
  // bin's mtime and size, which catches an edited bin on its own, but not a changed lib; setup
  // knows the module's whole code changed, so it drops them all.
  clearTsCommandCache();

  const modulePath = join(cmd.env.MOD_PATH, name);

  if (!await cmd.sys.vfs.exists(cmd.access, modulePath)) {
    await cmd.writeError(`mod setup: module not found: ${modulePath}\n`);
    return 1;
  }

  const manifest = await readModJson(cmd.sys.vfs, cmd.access, modulePath);
  if (!manifest) {
    await cmd.writeError(`mod setup: no mod.json found in ${modulePath}\n`);
    return 1;
  }

  // Validate before touching anything. Setup puts bins on PATH and starts services, all live
  // immediately, so a module that cannot work must refuse rather than half-install.
  const { errors, warnings } = await validateManifest(cmd.sys.vfs, cmd.access, cmd.env.MOD_PATH, manifest);

  for (const warning of warnings) {
    await cmd.writeError(`mod setup: ${warning}\n`);
  }

  if (errors.length > 0) {
    for (const error of errors) {
      await cmd.writeError(`mod setup: ${error}\n`);
    }
    recordModuleSetup(name, errors);
    if (cmd.json) await cmd.writeJSON({ ok: false, errors });
    return 1;
  }

  if (!cmd.json) await cmd.write(`Setting up module '${manifest.name}'...\n`);

  // What went wrong, for the log as it happens and for `mod list` afterwards.
  const problems: string[] = [];
  const fail = async (message: string) => {
    problems.push(message.trim());
    await cmd.writeError(`  ${message}`);
  };

  // Register the settings this module owns, so they appear in `config list` and
  // in the settings UI without core knowing what any of them mean.
  const declaredOptions = manifestConfigOptions(manifest);
  if (declaredOptions.length > 0) {
    const registered = registerConfigOptions(manifest.name, declaredOptions);
    if (!cmd.json && registered.length > 0) await cmd.write(`  settings: ${registered.join(', ')}\n`);
  }

  // What the module contributes to core's machinery: completable node types (in memory), the
  // store indexes its data is asked by and the archive roots its content lives under. Invalid
  // declarations are logged and none is used.
  const contributions = contributionsOf(manifest);
  const accepted = registerContributions(manifest.name, contributions);
  if (accepted && contributions.roots?.length) {
    try {
      const created = await ensureArchiveRoots(cmd.sys.vfs, contributions.roots);
      if (created.length && !cmd.json) await cmd.write(`  roots: ${created.join(', ')}\n`);
    } catch (error) {
      await cmd.writeError(`mod setup: ${manifest.name}: roots: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  if (accepted && contributions.indexes?.length) {
    try {
      await cmd.sys.vfs.ensureAttrIndexes(cmd.access, contributions.indexes);
      if (!cmd.json) await cmd.write(`  indexes: ${contributions.indexes.map((index) => index.name).join(', ')}\n`);
    } catch (error) {
      await cmd.writeError(`mod setup: ${manifest.name}: indexes: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }

  // 1. Copy etc/ files to /etc (no replace)
  const etcPath = join(modulePath, 'etc');
  if (await cmd.sys.vfs.exists(cmd.access, etcPath)) {
    const etcChildren = await cmd.sys.vfs.children(cmd.access, etcPath);
    for (const child of etcChildren) {
      // Its settings and drop-in directories are linked instead (step 6), so removing the module takes them back.
      if (isLinkedEtc(child.name)) continue;
      const srcPath = join(etcPath, child.name);
      const destPath = join(cmd.env.ETC_PATH, child.name);
      if (await cmd.sys.vfs.exists(cmd.access, destPath)) {
        if (!cmd.json) await cmd.write(`  etc/${child.name} already exists, skipping\n`);
      } else {
        const res = await cmd.execute(`cp ${srcPath} ${destPath}`);
        if (res.code !== 0) {
          await fail(`failed to copy etc/${child.name}: ${res.stderr}`);
        } else {
          if (!cmd.json) await cmd.write(`  Copied etc/${child.name} to ${destPath}\n`);
        }
      }
    }
  }

  // 2. Add bin/ to PATH in /etc/bashrc
  const binPath = join(modulePath, 'bin');
  if (await cmd.sys.vfs.exists(cmd.access, binPath)) {
    const rcPath = join(cmd.env.ETC_PATH, 'bashrc');
    const exportLine = buildPathExportLine(binPath);

    let alreadyAdded = false;
    try {
      const handle = await cmd.sys.vfs.open(cmd.access, rcPath, { mode: 'r' });
      try {
        const content = await toText(handle.readable);
        alreadyAdded = content.includes(binPath);
      } finally {
        await handle.close();
      }
    } catch {
      // No bashrc yet: the append creates it.
    }

    if (alreadyAdded) {
      if (!cmd.json) await cmd.write(`  bin/ already in PATH\n`);
    } else {
      const res = await cmd.execute(
        `echo '${exportLine}' >> ${rcPath}`,
      );
      if (res.code !== 0) {
        await cmd.writeError(`  failed to update bashrc: ${res.stderr}\n`);
        return 1;
      }
      if (!cmd.json) await cmd.write(`  Added ${binPath} to PATH\n`);
    }
  }

  // 3. Register services
  const servicesPath = join(modulePath, 'services');
  const currentServiceNames = new Set<string>();
  if (await cmd.sys.vfs.exists(cmd.access, servicesPath)) {
    const children = await cmd.sys.vfs.children(cmd.access, servicesPath);

    for (const child of children) {
      const servicePath = join(servicesPath, child.name);
      const serviceName = child.name;
      currentServiceNames.add(serviceName);

      // `service add` takes a directory with a start.sh; a single script is wrapped in one.
      if (child.node.type === NODE_TYPE_DIRECTORY) {
        const res = await cmd.execute(
          `service add ${serviceName} ${servicePath}`,
        );

        if (res.code !== 0) {
          await fail(`service add ${serviceName}: ${res.stderr}`);
        } else {
          const enabled = await cmd.execute(`service enable ${serviceName}`);
          if (enabled.code !== 0) {
            await fail(`service enable ${serviceName}: ${enabled.stderr}`);
          } else if (!cmd.json) {
            await cmd.write(`  Enabled service '${serviceName}'\n`);
          }
        }
      } else {
        const wrapperDir = join(
          cmd.env.ETC_PATH,
          'service-scripts',
          serviceName,
        );
        const res = await cmd.execute(
          `mkdir -p ${wrapperDir} && ln -sf ${servicePath} ${wrapperDir}/start.sh && service add ${serviceName} ${wrapperDir}`,
        );
        if (res.code !== 0) {
          await fail(`service add ${serviceName}: ${res.stderr}`);
        } else {
          const enabled = await cmd.execute(`service enable ${serviceName}`);
          if (enabled.code !== 0) {
            await fail(`service enable ${serviceName}: ${enabled.stderr}`);
          } else if (!cmd.json) {
            await cmd.write(`  Added and enabled service '${serviceName}'\n`);
          }
        }
      }
    }
  }

  // A registered service is a link under /etc/services/available back into the module's
  // services directory (or, for a single-script service, into a wrapper whose start.sh is). One
  // the module does not ship any more is retired, or every boot would try to start it. Only
  // services owned by this module are retired; one an operator registered with `service add` is
  // not ours to touch.
  const registeredServicesPath = join(cmd.env.SERVICES_PATH || SERVICES_PATH, 'available');
  const wrapperRoot = join(cmd.env.ETC_PATH, 'service-scripts');
  if (await cmd.sys.vfs.exists(cmd.access, registeredServicesPath)) {
    const registered = await cmd.sys.vfs.children(cmd.access, registeredServicesPath, { readlink: true });
    for (const service of registered) {
      if (currentServiceNames.has(service.name)) continue;

      const target = service.node.props.softlink;
      if (typeof target !== 'string') continue;

      const wrapperDir = join(wrapperRoot, service.name);
      let owned = target.startsWith(`${servicesPath}/`);
      if (!owned && target === wrapperDir) {
        try {
          const start = await cmd.sys.vfs.get(cmd.access, join(wrapperDir, 'start.sh'), { follow: false });
          owned = typeof start.props.softlink === 'string' && start.props.softlink.startsWith(`${servicesPath}/`);
        } catch {
          // The wrapper is gone or unreadable, so nothing says it was ours.
        }
      }
      if (!owned) continue;

      await cmd.execute(`service stop ${service.name}`); // ignore: may not be running
      await cmd.execute(`service disable ${service.name}`); // ignore: may not be enabled
      const res = await cmd.execute(`service remove ${service.name}`);
      if (res.code !== 0) {
        await fail(`service remove ${service.name}: ${res.stderr}`);
        continue;
      }
      if (target === wrapperDir) await cmd.execute(`rm -rf ${wrapperDir}`);
      if (!cmd.json) await cmd.write(`  Retired service '${service.name}'\n`);
    }
  }

  // 4. Register pipelines
  const pipelinesDir = join(modulePath, 'pipelines');
  const currentPipelineNames = new Set<string>();
  let pipelineDefinitionsValid = true;
  if (await cmd.sys.vfs.exists(cmd.access, pipelinesDir)) {
    const children = await cmd.sys.vfs.children(cmd.access, pipelinesDir);

    for (const child of children) {
      if (!child.name.endsWith('.yaml') && !child.name.endsWith('.yml')) continue;

      const yamlPath = join(pipelinesDir, child.name);
      const res = await cmd.execute(`pipeline define ${yamlPath}`);
      if (res.code !== 0) {
        await fail(`pipeline define ${child.name}: ${res.stderr}`);
        pipelineDefinitionsValid = false;
      } else {
        try {
          const handle = await cmd.sys.vfs.open(cmd.access, yamlPath, { mode: 'r' });
          try {
            currentPipelineNames.add(parsePipeline(await toText(handle.readable)).name);
          } finally {
            await handle.close();
          }
        } catch {
          // pipeline define just parsed this same file, so this can only be a
          // concurrent source change. Do not reconcile from a partial view.
          pipelineDefinitionsValid = false;
        }
        if (!cmd.json) await cmd.write(`  Registered pipeline '${child.name}'\n`);
      }
    }
  }

  // Definitions are symlinks back into the module's pipelines directory. One
  // whose YAML the module does not ship any more is undefined, so a renamed
  // pipeline stops matching events. Reconcile only links owned by this module;
  // definitions installed from elsewhere are not ours to touch. If any current
  // definition failed, leave the set as it is rather than turning a broken
  // upgrade into destructive partial removal.
  if (pipelineDefinitionsValid) {
    const definitionsPath = join(cmd.env.PIPELINES_PATH || PIPELINES_PATH, 'definitions');
    if (await cmd.sys.vfs.exists(cmd.access, definitionsPath)) {
      const definitions = await cmd.sys.vfs.children(cmd.access, definitionsPath, { readlink: true });
      for (const definition of definitions) {
        const target = definition.node.props.softlink;
        if (typeof target !== 'string' || !target.startsWith(`${pipelinesDir}/`)) continue;
        if (currentPipelineNames.has(definition.name)) continue;

        const res = await cmd.execute(`pipeline undefine ${definition.name}`);
        if (res.code !== 0) {
          await fail(`pipeline undefine ${definition.name}: ${res.stderr}`);
        } else if (!cmd.json) {
          await cmd.write(`  Retired pipeline '${definition.name}'\n`);
        }
      }
    }
  }

  // 5. Link a site into /www. Only a built site: a module's ui/ may also hold the sources of
  // its pages, which are bundled, not served (ein/core#427). A link this module made to
  // a ui/ that is no site is retired, so that sources are never served under the module's
  // host name.
  const uiPath = join(modulePath, 'ui');
  const wwwPath = cmd.env.WWW_PATH || WWW_PATH;
  const siteLink = join(wwwPath, manifest.name);
  if (await cmd.sys.vfs.exists(cmd.access, join(uiPath, 'index.html'))) {
    await cmd.execute(`mkdir -p ${wwwPath}`);

    if (await cmd.sys.vfs.exists(ADMIN_ACCESS, siteLink, { follow: false })) {
      if (!cmd.json) await cmd.write(`  UI already linked at ${siteLink}\n`);
    } else {
      const res = await cmd.execute(`ln -s ${uiPath} ${siteLink}`);
      if (res.code !== 0) {
        await fail(`failed to link UI: ${res.stderr}`);
      } else {
        if (!cmd.json) await cmd.write(`  Linked UI at ${siteLink}\n`);
      }
    }
  } else {
    try {
      const link = await cmd.sys.vfs.get(ADMIN_ACCESS, siteLink, { follow: false });
      if (typeof link.props.softlink === 'string' && link.props.softlink.startsWith(`${modulePath}/`)) {
        await cmd.sys.vfs.unlink(ADMIN_ACCESS, siteLink, wwwPath, { readlink: true });
        if (!cmd.json) await cmd.write(`  Retired UI link at ${siteLink}\n`);
      }
    } catch {
      // Not linked.
    }
  }

  // 6. Link its navigation entries into /etc/ui/nav.d, its settings into /etc/config.d and its drop-ins into /etc/<x>.d
  for (const problem of await linkModuleFiles(cmd, manifest.name, modulePath)) await fail(problem);

  // 7. Link docs/ into the module docs directory
  const docsPath = join(modulePath, 'docs');
  if (await cmd.sys.vfs.exists(cmd.access, docsPath)) {
    const linkPath = join(DOCS_MODULES_PATH, manifest.name);

    // Boot sets the modules up before it creates this directory.
    await cmd.execute(`mkdir -p ${DOCS_MODULES_PATH}`);

    if (await cmd.sys.vfs.exists(ADMIN_ACCESS, linkPath, { follow: false })) {
      if (!cmd.json) await cmd.write(`  Docs already linked at ${linkPath}\n`);
    } else {
      const res = await cmd.execute(`ln -s ${docsPath} ${linkPath}`);
      if (res.code !== 0) {
        await fail(`failed to link docs: ${res.stderr}`);
      } else {
        if (!cmd.json) await cmd.write(`  Linked docs at ${linkPath}\n`);
      }
    }
  }

  // The `{ ok: true }` JSON belongs to the caller, not here — `--all` sets up many modules and
  // must emit one object, not one per module.
  if (problems.length > 0) {
    await cmd.writeError(`mod setup: module '${manifest.name}' setup incomplete\n`);
    recordModuleSetup(name, problems);
    return 1;
  }

  recordModuleSetup(name, []);

  if (!cmd.json) await cmd.write(`Module '${manifest.name}' setup complete\n`);
  return 0;
};

modSetup.spec = {
  name: 'mod-setup',
  admin: true,
  effect: 'write' as const,
  description: 'Set up a module already in the modules directory',
  args: [
    {
      name: 'name',
      type: 'string' as const,
      description: 'Module name (directory name under /modules), or --all for every module in dependency order',
    },
  ],
};
