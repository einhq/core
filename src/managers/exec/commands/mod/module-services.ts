import { join } from '@std/path';
import type { ServiceEntry } from '../../../../lib/api/mod.ts';
import { MOD_PATH } from '../../../../lib/paths.ts';
import type { Command } from '../../command.ts';

/** The names of a module's services, as `mod setup` registers them. */
export const servicesOf = async (cmd: Command, name: string): Promise<string[]> => {
  try {
    return (await cmd.sys.vfs.children(cmd.access, join(cmd.env.MOD_PATH || MOD_PATH, name, 'services'))).map((child) => child.name);
  } catch {
    return [];
  }
};

/** Restart services, or start them; one that will not is said, as `by` says it, and fails nothing. */
export const restartServices = async (cmd: Command, names: string[], by: string): Promise<void> => {
  for (const name of names) {
    const res = await cmd.execute(`service restart ${name}`);
    if (res.code !== 0) await cmd.writeError(`${by}: service ${name} did not restart: ${res.stderr.trim()}\n`);
    else if (!cmd.json) await cmd.write(`  Restarted service '${name}'\n`);
  }
};

/** The services running now. */
export const runningServices = async (cmd: Command): Promise<Set<string>> => {
  const res = await cmd.execute('JSON_OUTPUT=1 service-list');
  if (res.code !== 0) return new Set();
  try {
    return new Set((JSON.parse(res.stdout) as ServiceEntry[]).filter((service) => service.enabled && service.status === 'running').map((service) => service.name));
  } catch {
    return new Set();
  }
};
