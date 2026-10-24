import { DOCS_MODULES_PATH, PIPELINES_PATH, SERVICES_PATH, WWW_PATH } from '../../../../lib/paths.ts';
import { join } from '@std/path';
import { toText } from '@std/streams/to-text';
import { ADMIN_ACCESS } from '../../../../lib/access/mod.ts';
import type { Command } from '../../command.ts';
import { buildPathExportLine } from './path-line.ts';
import { unlinkModuleFiles } from './module-links.ts';

/**
 * Forget modules that are installed but whose code is gone.
 *
 * A module is installed as a link under `/usr/modules` into wherever its code lives — the image,
 * or the dev mount. When a deploy drops a module, the link is left pointing at nothing, and
 * everything `mod setup` registered for it stays: its bin/ line in `/etc/bashrc`, its services —
 * enabled, so every boot tries to start them — its pipeline definitions, its `/www`, navigation
 * and docs links. `mod remove` cannot help: it reads the module's own directory to know what to
 * undo, and that directory is what went away. And a registration that points outside a module
 * reads as an operator's to `mod setup`, so another module could never take over its name.
 *
 * So everything is found from the registrations' side: whatever points into
 * `/usr/modules/<gone>/` is undone. Only a *link whose target is missing* counts as gone — a real
 * directory without a readable mod.json may be a module half way through an install, and is left
 * alone.
 *
 * Returns the names pruned. Best-effort per registration, like `mod remove`.
 */
export const pruneVanishedModules = async (cmd: Command): Promise<string[]> => {
  const modulesPath = cmd.env.MOD_PATH;
  let entries;
  try {
    entries = await cmd.sys.vfs.children(cmd.access, modulesPath, { readlink: true });
  } catch {
    return [];
  }

  const pruned: string[] = [];
  for (const entry of entries) {
    if (typeof entry.node.props.softlink !== 'string') continue;
    const modulePath = join(modulesPath, entry.name);
    if (await cmd.sys.vfs.exists(cmd.access, modulePath)) continue;

    await undoRegistrations(cmd, entry.name, modulePath);
    try {
      await cmd.sys.vfs.unlink(ADMIN_ACCESS, modulePath, modulesPath, { readlink: true });
    } catch (error) {
      await cmd.writeError(`  failed to unlink ${modulePath}: ${(error as Error).message}\n`);
      continue;
    }
    pruned.push(entry.name);
    if (!cmd.json) await cmd.write(`mod setup: module '${entry.name}' is gone, removed what it had registered\n`);
  }
  return pruned;
};

const undoRegistrations = async (cmd: Command, name: string, modulePath: string): Promise<void> => {
  const prefix = `${modulePath}/`;

  // Services: a link into the module's services/, or a wrapper whose start.sh is one.
  const available = join(cmd.env.SERVICES_PATH || SERVICES_PATH, 'available');
  const wrapperRoot = join(cmd.env.ETC_PATH, 'service-scripts');
  try {
    for (const service of await cmd.sys.vfs.children(cmd.access, available, { readlink: true })) {
      const target = service.node.props.softlink;
      if (typeof target !== 'string') continue;

      const wrapperDir = join(wrapperRoot, service.name);
      let owned = target.startsWith(prefix);
      if (!owned && target === wrapperDir) {
        try {
          const start = await cmd.sys.vfs.get(cmd.access, join(wrapperDir, 'start.sh'), { follow: false });
          owned = typeof start.props.softlink === 'string' && start.props.softlink.startsWith(prefix);
        } catch {
          // No wrapper: nothing says it was this module's.
        }
      }
      if (!owned) continue;

      await cmd.execute(`service stop ${service.name}`); // ignore: it cannot be running
      await cmd.execute(`service disable ${service.name}`);
      const res = await cmd.execute(`service remove ${service.name}`);
      if (res.code !== 0) await cmd.writeError(`  service remove ${service.name}: ${res.stderr}`);
      if (target === wrapperDir) await cmd.execute(`rm -rf ${wrapperDir}`);
    }
  } catch {
    // No services registered at all.
  }

  // Pipeline definitions: links back into the module's pipelines/.
  const definitions = join(cmd.env.PIPELINES_PATH || PIPELINES_PATH, 'definitions');
  try {
    for (const definition of await cmd.sys.vfs.children(cmd.access, definitions, { readlink: true })) {
      const target = definition.node.props.softlink;
      if (typeof target !== 'string' || !target.startsWith(prefix)) continue;
      const res = await cmd.execute(`pipeline undefine ${definition.name}`);
      if (res.code !== 0) await cmd.writeError(`  pipeline undefine ${definition.name}: ${res.stderr}`);
    }
  } catch {
    // No pipelines defined at all.
  }

  // The bin/ line in /etc/bashrc.
  const line = buildPathExportLine(join(modulePath, 'bin'));
  const rcPath = join(cmd.env.ETC_PATH, 'bashrc');
  try {
    const handle = await cmd.sys.vfs.open(cmd.access, rcPath, { mode: 'r' });
    let content: string;
    try {
      content = await toText(handle.readable);
    } finally {
      await handle.close();
    }
    const kept = content.split('\n').filter((row) => row !== line);
    if (kept.length !== content.split('\n').length) {
      const write = await cmd.sys.vfs.open(cmd.access, rcPath, { mode: 'w' });
      try {
        await write.write(new TextEncoder().encode(kept.join('\n')));
      } finally {
        await write.close();
      }
    }
  } catch (error) {
    await cmd.writeError(`  failed to update bashrc: ${(error as Error).message}\n`);
  }

  await unlinkModuleFiles(cmd, name, modulePath);

  // The /www and docs links, named after the module.
  for (const parent of [cmd.env.WWW_PATH || WWW_PATH, DOCS_MODULES_PATH]) {
    const linkPath = join(parent, name);
    try {
      const link = await cmd.sys.vfs.get(ADMIN_ACCESS, linkPath, { follow: false });
      if (typeof link.props.softlink !== 'string' || !link.props.softlink.startsWith(prefix)) continue;
      await cmd.sys.vfs.unlink(ADMIN_ACCESS, linkPath, parent, { readlink: true });
    } catch {
      // Not linked.
    }
  }
};
