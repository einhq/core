import type { UserResolved } from '../../../../lib/api/users.ts';
import { parseArgs } from '../../../../lib/args/mod.ts';
import { isUserNode, UserAttrs } from '../../../../vfs/types/user.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

export const userResolve = async (cmd: Command): CmdReturn => {
  // `0` is an id, not a missing argument; an id is told from a name below.
  const flags = parseArgs(cmd.args);
  const input = flags._[0] as string | undefined;

  if (!input) {
    await cmd.writeError('user resolve: missing uid or username\n');
    return 1;
  }

  try {
    const users = (await cmd.sys.vfs.children<UserAttrs>(cmd.access, cmd.env.USERS_PATH)).filter((entry) => isUserNode(entry.node));

    const asNumber = Number.parseInt(input, 10);
    const isNumeric = !Number.isNaN(asNumber) && String(asNumber) === input;

    if (isNumeric) {
      const user = users.find((u) => u.node.attrs.uid === asNumber);
      if (!user) {
        await cmd.writeError(`user resolve: uid ${input} not found\n`);
        return 1;
      }

      if (cmd.json) {
        await cmd.writeJSON(
          {
            uid: asNumber,
            username: user.name,
            title: user.node.attrs.name,
          } satisfies UserResolved,
        );
      } else {
        await cmd.write(`${user.name}\n`);
      }
    } else {
      const user = users.find((u) => u.name === input);
      if (!user) {
        await cmd.writeError(`user resolve: user '${input}' not found\n`);
        return 1;
      }

      if (cmd.json) {
        await cmd.writeJSON(
          {
            username: input,
            uid: user.node.attrs.uid,
            title: user.node.attrs.name,
          } satisfies UserResolved,
        );
      } else {
        await cmd.write(`${user.node.attrs.uid}\n`);
      }
    }

    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`user resolve: ${message}\n`);
    return 1;
  }
};

userResolve.spec = {
  name: 'user-resolve',
  effect: 'read' as const,
  description: 'Resolve username to UID or vice versa',
  args: [
    {
      name: 'uid_or_username',
      type: 'string' as const,
      description: 'uid (numeric) or username to resolve',
    },
  ],
  flags: [],
};
