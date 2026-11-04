import { join } from '@std/path';
import { ADMIN_ACCESS } from '../../../../lib/access/mod.ts';
import { parseArgs } from '../../../../lib/args/mod.ts';
import type { ServiceEntry } from '../../../../lib/api/system.ts';
import { ETC_PATH, LIB_PATH, MOD_PATH, SERVICES_PATH } from '../../../../lib/paths.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

/**
 * How long one `statusCommand` may take before its line is dropped.
 *
 * These answer from something the service already has in hand, so warm they take milliseconds.
 * The budget is sized for the cold call instead: a module's `#!ts` bin is loaded and evaluated on
 * first use, which is the first poll after a restart, when someone is looking. It remains a bound
 * on a wedged service, not patience — the calls run in parallel and a detail line is never worth
 * delaying the list for.
 */
const STATUS_COMMAND_TIMEOUT_MS = 2500;

/**
 * Run a command a service declared about itself (`statusCommand`, `checkCommand`, `gaugeCommand`)
 * and return its stdout, or null if it threw or took longer than `STATUS_COMMAND_TIMEOUT_MS`.
 *
 * `JSON_OUTPUT` is set first, not as a prefix: a prefix assignment comes after the command's own
 * words are expanded, so a command reading `$JSON_OUTPUT` would still see the caller's. The call
 * runs in a subshell, so the setting goes no further.
 */
export const askService = async (cmd: Command, command: string, json: boolean): Promise<string | null> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      cmd.execute(`JSON_OUTPUT=${json ? 1 : 0}; ${command}`),
      new Promise<null>((resolve) => timer = setTimeout(() => resolve(null), STATUS_COMMAND_TIMEOUT_MS)),
    ]);
    return result?.stdout ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

/**
 * Ask each running service what it says about itself, in parallel.
 *
 * The declared command's first line of stdout is the detail. Stdout rather than the exit code,
 * and regardless of it: a service reporting that it cannot reach its own socket has said
 * something worth showing, and failing silently there would hide exactly the case this exists
 * for. Nothing else is interpreted — core does not know what any of these lines mean.
 *
 * Only running services are asked. A stopped one has nothing to report and its row already says
 * so, and starting a probe against it would be doing work on a service an operator has
 * deliberately turned off.
 */
const serviceDetails = async (cmd: Command, services: { name: string; statusCommand?: string; status: string }[]): Promise<Map<string, string>> => {
  const asked = services.filter((service) => service.statusCommand && service.status === 'running');
  const details = new Map<string, string>();

  await Promise.all(asked.map(async (service) => {
    // Text, not JSON: this list is itself usually run with JSON_OUTPUT=1, and the shell passes the
    // environment down, so without it a well-behaved command answers in JSON and the detail
    // becomes a serialized object where a line was wanted. A failure is silent: a detail beside a
    // status is never worth failing the whole list for.
    const stdout = await askService(cmd, service.statusCommand!, false);
    const line = stdout?.split('\n').find((row) => row.trim().length > 0)?.trim();
    if (line) details.set(service.name, line);
  }));

  return details;
};

/**
 * Who ships each service, by where its registration links: `core` for core's own `services/`, the
 * module's name for `<MOD_PATH>/<module>/services/`, directly or through the wrapper `mod setup`
 * makes for a single-script service, whose `start.sh` is then the link. It is the ownership
 * `mod setup` retires services by. A service linked from anywhere else has no owner.
 *
 * Read with the access the manager lists services with: whoever may see a service may see where
 * it comes from.
 */
const serviceModules = async (cmd: Command, names: string[]): Promise<Map<string, string>> => {
  const available = join(cmd.env.SERVICES_PATH || SERVICES_PATH, 'available');
  const wrapperRoot = join(cmd.env.ETC_PATH || ETC_PATH, 'service-scripts');
  const coreServices = `${join(cmd.env.LIB_PATH || LIB_PATH, 'core', 'services')}/`;
  const modulesRoot = `${cmd.env.MOD_PATH || MOD_PATH}/`;

  const linkAt = async (path: string): Promise<string | undefined> => {
    try {
      const node = await cmd.sys.vfs.get(ADMIN_ACCESS, path, { follow: false });
      return typeof node.props.softlink === 'string' ? node.props.softlink : undefined;
    } catch {
      return undefined;
    }
  };

  const owners = new Map<string, string>();
  await Promise.all(names.map(async (name) => {
    let target = await linkAt(join(available, name));
    if (target === join(wrapperRoot, name)) target = await linkAt(join(target, 'start.sh'));
    if (!target) return;

    if (target.startsWith(coreServices)) {
      owners.set(name, 'core');
    } else if (target.startsWith(modulesRoot)) {
      const [module, directory] = target.slice(modulesRoot.length).split('/');
      if (directory === 'services') owners.set(name, module);
    }
  }));

  return owners;
};

/** Every registered service and who ships it; with `detail`, each running one's own status line too. */
export const listServices = async (cmd: Command, detail: boolean): Promise<ServiceEntry[]> => {
  const services = await cmd.sys.serviceManager?.list() ?? [];
  const [details, modules] = await Promise.all([
    detail ? serviceDetails(cmd, services) : new Map<string, string>(),
    serviceModules(cmd, services.map((svc) => svc.name)),
  ]);

  return services.map((svc) => ({
    name: svc.name,
    status: svc.status,
    enabled: svc.enabled,
    description: svc.description ?? '',
    restartCount: svc.restartCount ?? 0,
    module: modules.get(svc.name),
    // "running" alone carries no sense of whether that means days or seconds ago.
    startedAt: svc.startedAt,
    detail: details.get(svc.name),
  }));
};

export const serviceList = async (cmd: Command): CmdReturn => {
  if (!cmd.sys.serviceManager) {
    await cmd.writeError('service: service registry not available\n');
    return 1;
  }

  const flags = parseArgs(cmd.args, { boolean: ['detail'] });
  const services = await listServices(cmd, flags.detail === true);

  if (cmd.json) {
    await cmd.writeJSON(services satisfies ServiceEntry[]);
    return 0;
  }

  if (services.length === 0) {
    await cmd.write('No services found\n');
    return 0;
  }

  await cmd.write('NAME                 MODULE         STATUS      ENABLED  RESTARTS DESCRIPTION\n');
  await cmd.write('-------------------- -------------- ----------- -------- -------- -----------\n');

  for (const svc of services) {
    const name = svc.name.padEnd(20);
    const module = (svc.module ?? '-').padEnd(14);
    const status = svc.status.padEnd(11);
    const enabled = (svc.enabled ? 'yes' : 'no').padEnd(8);
    const restarts = String(svc.restartCount).padEnd(8);
    await cmd.write(`${name} ${module} ${status} ${enabled} ${restarts} ${svc.description}\n`);
    // Below the row rather than in a column: these are the lines that say a service is up and
    // still not well, and they are too long to share a line with anything.
    if (svc.detail) await cmd.write(`${''.padEnd(36)}${svc.detail}\n`);
  }

  return 0;
};

serviceList.spec = {
  name: 'service-list',
  effect: 'read' as const,
  description: 'List services, with the module that ships each and how often it has restarted',
  args: [],
  flags: [
    { name: 'detail', type: 'bool' as const, description: 'Also ask each running service for its own status line (its declared statusCommand)' },
  ],
};
