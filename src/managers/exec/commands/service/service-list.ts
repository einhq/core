import { parseArgs } from '../../../../lib/args/mod.ts';
import type { ServiceEntry } from '../../../../lib/api/system.ts';
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

/** Every registered service; with `detail`, each running one's own status line too. */
export const listServices = async (cmd: Command, detail: boolean): Promise<ServiceEntry[]> => {
  const services = await cmd.sys.serviceManager?.list() ?? [];
  const details = detail ? await serviceDetails(cmd, services) : new Map<string, string>();

  return services.map((svc) => ({
    name: svc.name,
    status: svc.status,
    enabled: svc.enabled,
    description: svc.description ?? '',
    restartCount: svc.restartCount ?? 0,
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

  await cmd.write('NAME                 STATUS      ENABLED  RESTARTS DESCRIPTION\n');
  await cmd.write('-------------------- ----------- -------- -------- -----------\n');

  for (const svc of services) {
    const name = svc.name.padEnd(20);
    const status = svc.status.padEnd(11);
    const enabled = (svc.enabled ? 'yes' : 'no').padEnd(8);
    const restarts = String(svc.restartCount).padEnd(8);
    await cmd.write(`${name} ${status} ${enabled} ${restarts} ${svc.description}\n`);
    // Below the row rather than in a column: these are the lines that say a service is up and
    // still not well, and they are too long to share a line with anything.
    if (svc.detail) await cmd.write(`${''.padEnd(21)}${svc.detail}\n`);
  }

  return 0;
};

serviceList.spec = {
  name: 'service-list',
  effect: 'read' as const,
  description: 'List services, with how often each has restarted',
  args: [],
  flags: [
    { name: 'detail', type: 'bool' as const, description: 'Also ask each running service for its own status line (its declared statusCommand)' },
  ],
};
