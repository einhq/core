import { join } from '@std/path';
import { toText } from '@std/streams/to-text';
import { readModJson } from '../../../../modules/mod.ts';
import { stageTsCommand } from '../../../shell/ts-command-loader.ts';
import { NODE_TYPE_FILE } from '../../../../vfs/types/file.ts';
import type { Command } from '../../command.ts';
import { CmdReturn } from '../../types.ts';

/**
 * Pre-fetch a module's `#!ts` dependencies.
 *
 * Without this the first run of a bin resolves its imports live — for a module installed at
 * runtime that means a network fetch inside a pipeline step, where there is no network guarantee
 * and the failure surfaces as a step error rather than as an install problem. Staging every bin
 * collects the `jsr:`, `npm:` and `http(s):` specifiers its graph imports, and `deno cache` over
 * those moves that work to install time. Staging also checks every bin's imports resolve.
 *
 * Failure is reported but not fatal: a module whose deps are already cached (every in-repo one)
 * must not be blocked from installing because the network is absent.
 */
export const modCache = async (cmd: Command): CmdReturn => {
  const name = cmd.args[0];

  if (!name) {
    await cmd.writeError('mod cache: missing module name\n');
    return 1;
  }

  const modulePath = join(cmd.env.MOD_PATH, name);
  const manifest = await readModJson(cmd.sys.vfs, cmd.access, modulePath);
  if (!manifest) {
    await cmd.writeError(`mod cache: not a module: ${modulePath}\n`);
    return 1;
  }

  const binPath = join(modulePath, 'bin');
  let entries;
  try {
    entries = await cmd.sys.vfs.children(cmd.access, binPath);
  } catch {
    if (cmd.json) await cmd.writeJSON({ ok: true, cached: 0 });
    return 0;
  }

  let commands = 0;
  const packages = new Set<string>();
  for (const entry of entries) {
    if (entry.node.type !== NODE_TYPE_FILE) continue;

    const path = join(binPath, entry.name);
    const handle = await cmd.sys.vfs.open(cmd.access, path, { mode: 'r' });
    let source: string;
    try {
      source = await toText(handle.readable);
    } finally {
      await handle.close();
    }
    if (!source.startsWith('#!ts')) continue;

    const staged = await stageTsCommand(cmd.sys.vfs, cmd.access, path, source, cmd.env.MOD_PATH);
    for (const spec of staged.packages) packages.add(spec);
    commands++;
  }

  if (packages.size === 0) {
    if (cmd.json) await cmd.writeJSON({ ok: true, cached: commands });
    return 0;
  }

  let ok = true;
  try {
    const output = await new Deno.Command(Deno.execPath(), {
      args: ['cache', ...packages],
      stdout: 'piped',
      stderr: 'piped',
    }).output();

    if (output.code !== 0) {
      ok = false;
      await cmd.writeError(`mod cache: ${new TextDecoder().decode(output.stderr).trim()}\n`);
    }
  } catch (error) {
    ok = false;
    await cmd.writeError(`mod cache: ${(error as Error).message}\n`);
  }

  if (cmd.json) {
    await cmd.writeJSON({ ok, cached: commands });
  } else if (ok) {
    await cmd.write(`Cached dependencies for ${commands} command(s) in '${name}'\n`);
  }

  return 0;
};

modCache.spec = {
  name: 'mod-cache',
  admin: true,
  effect: 'write' as const,
  description: "Pre-fetch a module's TypeScript command dependencies",
  args: [
    { name: 'name', type: 'string' as const, description: 'Module name (directory name under /modules)' },
  ],
};
