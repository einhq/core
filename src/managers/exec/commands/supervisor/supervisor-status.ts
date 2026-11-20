/**
 * supervisor status — the services beside EiN as the supervisor sees them: each one's container,
 * image and release, the newer release an update would install, what the modules ask of it, and the
 * install or update it runs or last ran. In
 * an installation without a supervisor it says so, and JSON says `configured: false`; a supervisor
 * that does not answer is a failure, and in JSON an answer with `error`, as a page shows it.
 */

import type { SupervisedService, SupervisorStatus } from '../../../../lib/api/mod.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';
import { askSupervisor, supervisorUrl } from './client.ts';

/** A service's state in a few words: installed or not, its container's, and what its modules ask. */
const describe = (service: SupervisedService): string => {
  const parts: string[] = [];
  if (!service.installed) parts.push(service.unknown ? 'not a service the supervisor knows' : 'not installed');
  else if (!service.state) parts.push('no container');
  else parts.push(service.health ? `${service.state}, ${service.health}` : service.state);
  if (service.image) parts.push(service.image);
  if (service.version && !service.image?.endsWith(`:${service.version}`)) parts.push(service.version);
  if (service.available) parts.push(`update to ${service.available.version ?? service.available.image}`);
  if (service.wanted) {
    const asking = service.wanted.modules.map(({ module, range }) => `${module} ${range}`).join(', ');
    parts.push(`asked for by ${asking}`);
  }
  return parts.join(' · ');
};

export const supervisorStatus = async (cmd: Command): CmdReturn => {
  if (!await supervisorUrl(cmd)) {
    if (cmd.json) {
      await cmd.writeJSON({ configured: false, services: [], job: null } satisfies SupervisorStatus);
      return 0;
    }
    await cmd.write('This installation has no supervisor: setup.sh on the machine installs and updates its services.\n');
    return 0;
  }
  let status: SupervisorStatus;
  try {
    status = { configured: true, ...await askSupervisor<Omit<SupervisorStatus, 'configured'>>(cmd, 'GET', '/v0/status') };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (cmd.json) {
      await cmd.writeJSON({ configured: true, error: message, services: [], job: null } satisfies SupervisorStatus);
      return 0;
    }
    await cmd.writeError(`supervisor status: ${message}\n`);
    return 1;
  }
  if (cmd.json) {
    await cmd.writeJSON(status satisfies SupervisorStatus);
    return 0;
  }
  const width = Math.max(...status.services.map((service) => service.name.length));
  for (const service of status.services) await cmd.write(`${service.name.padEnd(width)}  ${describe(service)}\n`);
  if (!status.services.some((service) => service.available)) await cmd.write('Every service runs its newest release.\n');
  await cmd.write(
    status.updateAt ? `Every service with an update is updated each night at ${status.updateAt}.\n` : 'The services are updated only when asked.\n',
  );
  if (status.checkError) await cmd.write(`GitHub's registry did not answer for every service: ${status.checkError}\n`);
  const job = status.job;
  if (job) {
    const what = `setup.sh ${job.args.join(' ')}, asked by ${job.by} at ${job.startedAt}`;
    await cmd.write(job.state === 'running' ? `Running: ${what}\n` : `Last: ${what}: ${job.state === 'done' ? 'done' : 'failed'}\n`);
    for (const line of job.lines.slice(job.state === 'running' ? -1 : -5)) await cmd.write(`  ${line}\n`);
  }
  return 0;
};

supervisorStatus.spec = {
  name: 'supervisor-status',
  admin: true,
  effect: 'read' as const,
  description: 'The services beside EiN, as the supervisor that installs and updates them sees them',
};
