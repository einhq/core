/**
 * Shared subcommand dispatch for the `group: true` commands.
 *
 * A group command is a thin router: `pipeline status` becomes `pipeline-status`.
 * Commands whose spec says `daemon: true`, such as `pipeline-engine`, are
 * refused and named as the service they belong to: run from a caller's session,
 * a second engine would consume the same queue and advance every instance twice.
 */

import type { Command } from '../command.ts';
import type { CmdReturn } from '../types.ts';

/**
 * Re-quote an argument for `executeInline`.
 *
 * Escape before quoting: arguments arrive already expanded by the caller's
 * shell, and a bare `"${a}"` would split `--params '{"kind":"a"}'` into nonsense
 * and re-expand any `$` or backtick the value carries.
 */
const quote = (arg: string): string => `"${arg.replace(/(["\\$`])/g, '\\$1')}"`;

export const dispatchSubcommand = async (cmd: Command, group: string): CmdReturn => {
  const [subcommand, ...args] = cmd.args;

  try {
    if (!subcommand) {
      throw new Error('missing subcommand');
    }

    const name = `${group}-${subcommand}`;

    if (cmd.sys.cem.get(name)?.daemon) {
      await cmd.writeError(`${group}: '${subcommand}' is a long-running daemon, not a subcommand\n`);
      await cmd.writeError(`Use 'service start ${name}' to run it\n`);
      return 1;
    }

    return cmd.executeInline(`${name} ${args.map(quote).join(' ')}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`${group}: ${message}\n`);
    return 1;
  }
};
