import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

const shellQuote = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`;

/**
 * Run a command detached from the start: start it in the background and
 * immediately disown it, so it is immune to SIGHUP on shell close and its
 * output goes to /var/logs/jobs/<pid>/. Typically the whole point of `nohup`.
 *
 * For a sequence rather than one command, put the steps in a file and detach
 * the file: `nohup source /home/admin/sweep.sh`. `source` is a builtin, and a
 * builtin is backgroundable like anything else.
 */
export const nohup = async (cmd: Command): CmdReturn => {
  if (cmd.args.length === 0) {
    await cmd.writeError('nohup: missing command\n');
    return 1;
  }

  const line = cmd.args.map(shellQuote).join(' ');
  await cmd.executeInline(`${line} &`);

  const info = await cmd.opts.tty.disownJob(undefined, cmd.opts.ctx);

  // No job to disown means the command was over before this point — it failed
  // to start, or finished and was reaped first. Nothing is detached, so that is
  // a failure, said out loud.
  if (!info) {
    await cmd.writeError(`nohup: ${cmd.args[0]}: nothing left to detach — it had already finished\n`);
    return 1;
  }

  const pid = info.pid;
  if (cmd.json) {
    await cmd.writeJSON({ ok: true, jobNum: info.jobNum, pid, log: `/var/logs/jobs/${pid}` });
  } else {
    await cmd.writeLn(`nohup: [${info.jobNum}] ${pid} -> /var/logs/jobs/${pid}/`);
  }

  return 0;
};

nohup.spec = {
  name: 'nohup',
  effect: 'write' as const,
  description: 'run a command detached, immune to shell hang-up, logging to /var/logs/jobs',
  args: [
    {
      name: 'command',
      type: 'string' as const,
      description: 'the command (and args) to run detached',
    },
  ],
  flags: [],
};
