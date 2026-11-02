/**
 * mod status — the module install running now, or else the last one since EiN started: what it
 * was asked, who asked, how far it has got and its last lines; with `--follow`, what it says until
 * it ends.
 */

import type { ModuleInstallStatus } from '../../../../lib/api/mod.ts';
import { parseArgs } from '../../../../lib/args/mod.ts';
import { installerOf, type InstallJob } from '../../../../modules/installer.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

/**
 * Say what `job` says, from its first line kept, until it ends, and answer 0 when it installed
 * all it was asked. Interrupted, or once the caller is gone, it stops following and the install
 * goes on. In JSON mode only its errors are said.
 */
export const followInstall = async (cmd: Command, job: InstallJob): Promise<number> => {
  let from = 0;
  try {
    while (true) {
      const { lines, next } = job.linesFrom(from);
      from = next;
      for (const line of lines) {
        if (line.error) await cmd.writeError(`${line.text}\n`);
        else if (!cmd.json) await cmd.write(`${line.text}\n`);
      }
      if (job.state !== 'running') return job.state === 'done' ? 0 : 1;
      if (cmd.interruptSignal.aborted) {
        await cmd.writeError(`mod install ${job.args.join(' ')} goes on; mod status says how far it has got\n`);
        return 130;
      }
      await job.next(cmd.interruptSignal);
    }
  } catch {
    // Whoever followed is gone; the install is not theirs to end.
    return 130;
  }
};

const elapsed = (ms: number): string => {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
};

export const modStatus = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, { boolean: ['follow'], alias: { f: 'follow' } });
  const job = installerOf(cmd.sys).job;

  if (flags.follow && job) {
    const code = await followInstall(cmd, job);
    if (cmd.json) await cmd.writeJSON({ install: job.toJSON() } satisfies ModuleInstallStatus);
    return code;
  }
  if (cmd.json) {
    await cmd.writeJSON({ install: job?.toJSON() ?? null } satisfies ModuleInstallStatus);
    return 0;
  }
  if (!job) {
    await cmd.write('No module has been installed since EiN started\n');
    return 0;
  }

  const status = job.toJSON();
  const asked = `mod install ${job.args.join(' ')}`;
  if (job.state === 'running') {
    await cmd.write(`${asked}: running for ${elapsed(Date.now() - job.startedAt.getTime())}, for ${job.by}\n`);
    if (job.unpacking) await cmd.write(`  ${job.unpacking.files} files of ${job.unpacking.module} unpacked\n`);
  } else {
    const took = elapsed(job.finishedAt!.getTime() - job.startedAt.getTime());
    await cmd.write(`${asked}: ${job.state === 'done' ? 'done' : 'failed'} at ${status.finishedAt}, after ${took}, for ${job.by}\n`);
  }
  for (const line of status.lines) await cmd.write(`  ${line.text}\n`);
  return 0;
};

modStatus.spec = {
  name: 'mod-status',
  effect: 'read' as const,
  description: 'Say how far the module install running now has got, or what the last one came to',
  flags: [
    { name: 'follow', type: 'bool' as const, description: 'Say what the install says until it ends, and exit as it does' },
  ],
};
