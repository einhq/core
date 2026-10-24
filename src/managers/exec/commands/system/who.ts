/**
 * who — who is signed in: each SSH login, terminal panel and web UI connection, the address it
 * connects from, when it opened, how long since its last input, and what it runs now.
 *
 * Read from the shells this process has open. A service's shell and a command run over SSH are
 * not sessions and are left out. Anyone but admin sees only their own.
 */

import type { SessionEntry, ShellOrigin } from '../../../../lib/api/system.ts';
import { openShellList } from '../../../shell/shell.ts';
import { colorer, cut, Table } from '../../../shell/terminal/mod.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';
import { accountNames, seesEveryone } from './accounts.ts';
import { fmtAge, fmtTty, lastColumnRoom } from './lib.ts';
import { commandLine } from './ps.ts';

const isSession = (origin: ShellOrigin): origin is SessionEntry['origin'] => origin === 'ssh' || origin === 'terminal' || origin === 'web';

/** Every open session the caller may see, oldest first. */
export const listSessions = async (cmd: Command): Promise<SessionEntry[]> => {
  const everyone = seesEveryone(cmd);
  const nameOf = await accountNames(cmd);

  // Per shell, the earliest foreground command still running: of `a | b`, the `a`.
  const running = new Map<string, { startedAt: number; line: string }>();
  for (const state of cmd.sys.cem.states()) {
    const opts = state.opts;
    if (state.state !== 'running' || !opts || opts.forground === false) continue;
    const earlier = running.get(opts.tty.name);
    if (earlier && earlier.startedAt <= state.startTime) continue;
    running.set(opts.tty.name, { startedAt: state.startTime, line: commandLine(state.name, opts.args, opts.label) });
  }

  const sessions: SessionEntry[] = [];
  for (const shell of openShellList()) {
    if (!isSession(shell.origin)) continue;
    if (!everyone && shell.access.uid !== cmd.access.uid) continue;
    sessions.push({
      tty: shell.name,
      origin: shell.origin,
      from: shell.from,
      uid: shell.access.uid,
      user: nameOf(shell.access.uid),
      since: shell.openedAt,
      activeAt: shell.activeAt,
      cwd: shell.cwd,
      command: running.get(shell.name)?.line,
    });
  }
  return sessions;
};

/** `14:02` today, `10-07 14:02` before. */
const fmtLogin = (at: number, now: number): string => {
  const date = new Date(at);
  const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  if (date.toDateString() === new Date(now).toDateString()) return time;
  return `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${time}`;
};

export const who = async (cmd: Command): CmdReturn => {
  const sessions = await listSessions(cmd);

  if (cmd.json) {
    await cmd.writeJSON(sessions satisfies SessionEntry[]);
    return 0;
  }

  const color = colorer(!cmd.tty);
  const table = new Table({ columns: ['USER', 'TTY', 'FROM', 'LOGIN', 'IDLE', 'WHAT'].map((name) => ({ name, align: name === 'IDLE' ? 'right' : 'left' })) });
  table.addRow({
    USER: color('dim', 'USER'),
    TTY: color('dim', 'TTY'),
    FROM: color('dim', 'FROM'),
    LOGIN: color('dim', 'LOGIN'),
    IDLE: color('dim', 'IDLE'),
    WHAT: color('dim', 'WHAT'),
  });

  const now = Date.now();
  const rows = sessions.map((session) => ({
    USER: session.user,
    TTY: fmtTty(session.tty, session.origin),
    FROM: session.from ?? '',
    LOGIN: fmtLogin(session.since, now),
    IDLE: fmtAge(now - session.activeAt),
    WHAT: session.command ?? '',
  }));
  const room = lastColumnRoom(cmd, rows, ['USER', 'TTY', 'FROM', 'LOGIN', 'IDLE']);
  for (const row of rows) {
    table.addRow({ ...row, TTY: color('cyan', row.TTY), FROM: row.FROM || color('dim', '-'), WHAT: row.WHAT ? cut(row.WHAT, room) : color('dim', '-') });
  }

  await cmd.write(table.render());
  return 0;
};

who.spec = {
  name: 'who',
  effect: 'read' as const,
  description:
    "List who is signed in: each SSH login, terminal and web UI connection, the address it connects from, its idle time and what it runs. Admin sees everyone's, anyone else their own",
  args: [],
  flags: [],
  returns: 'One row per open session, oldest first',
  examples: ['who'],
};
