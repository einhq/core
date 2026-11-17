/**
 * Passwords given as `-`, read from stdin. A command line is what `ps` and `who` show to whoever
 * may see the caller's commands, so a password the caller does not type at a prompt comes this
 * way: `login anna -`, `user-passwd anna --old-password=- --new-password=-`.
 */

import type { Command } from '../../command.ts';

/**
 * A reader of `cmd`'s password values: a value as it was given, or for `-` the next line of stdin,
 * without its line end. Stdin is read to its end at the first `-`; each `-` after it takes the line
 * after the one before, and one past the last line reads as empty.
 */
export const passwordReader = (cmd: Command): (value: string | undefined) => Promise<string | undefined> => {
  let lines: string[] | undefined;
  return async (value) => {
    if (value !== '-') return value;
    lines ??= (await cmd.stdin.text()).split(/\r?\n/);
    return lines.shift() ?? '';
  };
};
