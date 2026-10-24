/**
 * ps — the commands running now: whose they are, which shell they run in, how long they have run
 * and the line that started each.
 *
 * Every core command, command node and `#!ts` bin is a process of its own, and a bash script is
 * the commands it runs. They all run in this one process, so the execution manager's table is the
 * whole list. Anyone but admin sees only their own: a command line can carry what its author
 * would not show anyone else.
 */

import { parseArgs } from '../../../../lib/args/mod.ts';
import type { ProcessEntry } from '../../../../lib/api/system.ts';
import { shq } from '../../../../lib/shell-quote/mod.ts';
import { colorer, cut, Table } from '../../../shell/terminal/mod.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';
import { accountNames, seesEveryone } from './accounts.ts';
import { fmtAge, fmtTty, lastColumnRoom } from './lib.ts';

/** A word that reads the same quoted or not. */
const PLAIN_WORD = /^[\w./:=@%+,-]+$/;

/** A word as it would be typed: quoted only when it has to be. */
export const quoteWord = (word: string): string => PLAIN_WORD.test(word) ? word : shq(word);

/**
 * A label on one line, for a row: a job's lines joined into one that runs the same, by a space
 * where a line ends in `do`, `then`, `else`, `{`, `(`, `|` or `&`, and by `; ` elsewhere.
 */
export const labelLine = (label: string): string => label.trim().replace(/(\b(?:do|then|else)|[{(|&])[ \t]*\n\s*/g, '$1 ').replace(/\s*;?[ \t]*\n\s*/g, '; ');

/**
 * A command and its arguments as they would be typed; one with a label as its name and the label,
 * `bg: sleep 30`.
 */
export const commandLine = (name: string, args: string[], label?: string): string =>
  label !== undefined ? `${name}: ${labelLine(label)}` : [name, ...args].map(quoteWord).join(' ');

/** Every running command the caller may see, oldest first. */
export const listProcesses = async (cmd: Command): Promise<ProcessEntry[]> => {
  const everyone = seesEveryone(cmd);
  const nameOf = await accountNames(cmd);
  const processes: ProcessEntry[] = [];

  for (const state of cmd.sys.cem.states()) {
    const opts = state.opts;
    if (state.state !== 'running' || !opts) continue;
    if (!everyone && opts.access.uid !== cmd.access.uid) continue;

    const origin = opts.tty.origin;
    processes.push({
      pid: state.id,
      name: state.name,
      args: opts.args,
      label: opts.label,
      uid: opts.access.uid,
      user: nameOf(opts.access.uid),
      tty: opts.tty.name,
      origin,
      service: origin === 'service' ? opts.ctx.getEnv().SERVICE_NAME : undefined,
      startedAt: state.startTime,
      foreground: opts.forground !== false,
      cwd: opts.cwd,
    });
  }

  return processes.sort((a, b) => a.startedAt - b.startedAt);
};

export const ps = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, { string: ['user'], alias: { u: 'user' } });
  let processes = await listProcesses(cmd);
  if (flags.user) processes = processes.filter((entry) => entry.user === flags.user);

  if (cmd.json) {
    await cmd.writeJSON(processes satisfies ProcessEntry[]);
    return 0;
  }

  const color = colorer(!cmd.tty);
  const table = new Table({ columns: ['PID', 'USER', 'TTY', 'ELAPSED', 'COMMAND'].map((name) => ({ name, align: name === 'ELAPSED' ? 'right' : 'left' })) });
  table.addRow({ PID: color('dim', 'PID'), USER: color('dim', 'USER'), TTY: color('dim', 'TTY'), ELAPSED: color('dim', 'ELAPSED'), COMMAND: color('dim', 'COMMAND') });

  const now = Date.now();
  const rows = processes.map((entry) => ({
    PID: entry.pid,
    USER: entry.user,
    TTY: fmtTty(entry.tty, entry.origin, entry.service),
    ELAPSED: fmtAge(now - entry.startedAt),
    // A job started with `&` is marked as bash's `jobs` marks it.
    COMMAND: commandLine(entry.name, entry.args, entry.label) + (entry.foreground ? '' : ' &'),
  }));
  const room = lastColumnRoom(cmd, rows, ['PID', 'USER', 'TTY', 'ELAPSED']);
  for (const row of rows) {
    table.addRow({ ...row, PID: color('dim', row.PID), TTY: color('cyan', row.TTY), COMMAND: cut(row.COMMAND, room) });
  }

  await cmd.write(table.render());
  return 0;
};

ps.spec = {
  name: 'ps',
  effect: 'read' as const,
  description: "List the commands running now: pid, user, shell, how long, and the command line. Admin sees everyone's, anyone else their own",
  args: [],
  flags: [
    { name: 'user', type: 'user' as const, description: "Only this user's commands (-u)" },
  ],
  returns: 'One row per running command, oldest first',
  examples: ['ps', 'ps --user anna'],
};
