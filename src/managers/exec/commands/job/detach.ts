import { toText } from '@std/streams/to-text';
import { join } from '@std/path';
import { parseArgs } from '../../../../lib/args/mod.ts';
import { ADMIN_ACCESS } from '../../../../lib/access/mod.ts';
import { BOOT_ID } from '../../../../lib/boot-id/mod.ts';
import type { DetachedJobStatus } from '../../../shell/shell.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';
import { LOGS_PATH } from '../../../../lib/paths.ts';

const JOBS_LOG_BASE = `${LOGS_PATH}/jobs`;

/**
 * What a detached record says once this process's view is taken into account.
 * A record left `running` by a previous boot describes a job that died with the
 * process that wrote it, so it is reported as abandoned rather than running —
 * the one thing timestamps alone cannot tell you.
 */
type DetachedState = 'running' | 'exited' | 'abandoned';

const stateOf = (status: DetachedJobStatus): DetachedState => {
  if (status.state === 'exited') return 'exited';
  return status.bootId === BOOT_ID ? 'running' : 'abandoned';
};

const readStatus = async (cmd: Command, pid: string): Promise<DetachedJobStatus | undefined> => {
  try {
    const handle = await cmd.sys.vfs.open(ADMIN_ACCESS, join(JOBS_LOG_BASE, pid, 'status.json'), { mode: 'r' });
    try {
      const text = await toText(handle.readable);
      return text.trim() ? JSON.parse(text) as DetachedJobStatus : undefined;
    } finally {
      await handle.close();
    }
  } catch {
    // A job log directory with no readable status is not a detached job's.
    return undefined;
  }
};

/**
 * `detach --list`: the jobs that outlived the shells that started them.
 *
 * The shell's own job table cannot answer this: a detached job is deliberately
 * removed from it, and the shell that held it is usually gone by the time
 * anyone asks. The records under /var/logs/jobs are what is left, and they sit
 * beside that job's stdout.log and stderr.log.
 */
const listDetached = async (cmd: Command): CmdReturn => {
  let names: string[];
  try {
    names = (await cmd.sys.vfs.children(ADMIN_ACCESS, JOBS_LOG_BASE)).map((child) => child.name);
  } catch {
    names = [];
  }

  const found: DetachedJobStatus[] = [];
  for (const name of names) {
    const status = await readStatus(cmd, name);
    if (status) found.push(status);
  }
  found.sort((a, b) => b.startedAt - a.startedAt);

  if (cmd.json) {
    await cmd.writeJSON(found.map((status) => ({
      pid: status.pid,
      state: stateOf(status),
      command: status.command,
      startedAt: status.startedAt,
      exitedAt: status.exitedAt ?? null,
      exitCode: status.exitCode ?? null,
      log: join(JOBS_LOG_BASE, status.pid),
    })));
    return 0;
  }

  if (found.length === 0) {
    await cmd.writeLn('no detached jobs');
    return 0;
  }

  for (const status of found) {
    const state = stateOf(status);
    const suffix = state === 'exited' ? ` (${status.exitCode ?? '?'})` : '';
    await cmd.writeLn(`${status.pid}\t${state}${suffix}\t${new Date(status.startedAt).toISOString()}\t${status.command}`);
  }

  return 0;
};

/**
 * Detach a job so it survives its shell. First tries the shell's job table (a
 * background job — its output gets redirected to a log, which is what it adds
 * to the `disown` builtin); failing that, falls back to marking a running
 * command detached by pid, which only exempts it from SIGHUP (output stays
 * where it is). With `--list`, the detached jobs there are.
 */
export const detach = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, { boolean: ['list'] });

  if (flags.list) {
    return await listDetached(cmd);
  }

  const sel = flags._[0] === undefined ? undefined : String(flags._[0]);

  const info = await cmd.opts.tty.disownJob(sel, cmd.opts.ctx);
  if (info) {
    if (cmd.json) {
      await cmd.writeJSON({ ok: true, jobNum: info.jobNum, pid: info.pid || null, command: info.command });
    } else {
      await cmd.writeLn(`detached [${info.jobNum}] ${info.pid || '?'} ${info.command}`);
    }
    return 0;
  }

  if (sel && cmd.sys.cem.detach(sel)) {
    if (cmd.json) {
      await cmd.writeJSON({ ok: true });
    } else {
      await cmd.writeLn(`detached ${sel}`);
    }
    return 0;
  }

  await cmd.writeError(`detach: no such job: ${sel ?? ''}\n`);
  return 1;
};

detach.spec = {
  name: 'detach',
  effect: 'write' as const,
  description: 'detach a job so it keeps running after the shell closes',
  args: [
    {
      name: 'job',
      type: 'string' as const,
      description: 'job spec (%n), job number, or pid; defaults to the most recent job',
    },
  ],
  flags: [
    {
      name: 'list',
      type: 'bool' as const,
      description: 'list detached jobs system-wide instead, from their records under /var/logs/jobs',
    },
  ],
};
