import { basename, dirname, join } from '@std/path';
import { ADMIN_ACCESS } from '../../../../lib/access/mod.ts';
import { accessOfUid } from '../../../../lib/auth/member-gids.ts';
import { SESSIONS_PATH, USERS_PATH } from '../../../../lib/paths.ts';
import { shq } from '../../../../lib/shell-quote/mod.ts';
import { NODE_TYPE_SESSION, type SessionAttrs } from '../../../../vfs/types/session.ts';
import { isUserNode } from '../../../../vfs/types/user.ts';
import { Shell } from '../../../shell/shell.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

/** The uid of the account `who` names, by its username or as a number. */
const uidOf = async (cmd: Command, who: string): Promise<number | undefined> => {
  if (/^\d+$/.test(who)) return Number(who);
  const node = await cmd.sys.vfs.get(ADMIN_ACCESS, join(USERS_PATH, who)).catch(() => undefined);
  return node && isUserNode(node) ? node.attrs.uid : undefined;
};

/**
 * Run a command line as another account, with only what that account may do: for a service, which
 * runs as the administrator, doing work on someone's behalf (a rule its author wrote). The line
 * runs in a shell of its own, on a session of that account's made for it and removed after, so
 * what it writes is that account's and its settings are its own. Administrators only.
 *
 *   runas anna 'device-set hall-lamp/switch-0 on'
 *   runas 1004 ls -la /home/anna
 */
export const runas = async (cmd: Command): CmdReturn => {
  const [who, ...words] = cmd.args;
  if (!who || words.length === 0) {
    await cmd.writeError('usage: runas <user> <command line>\n');
    return 2;
  }
  const uid = await uidOf(cmd, who);
  const access = uid === undefined ? undefined : await accessOfUid(cmd.sys.vfs, uid);
  if (!access) {
    await cmd.writeError(`runas: ${who}: no active account\n`);
    return 1;
  }
  const line = words.length === 1 ? words[0] : words.map(shq).join(' ');

  const sessionPath = join(SESSIONS_PATH, `runas-${crypto.randomUUID()}`);
  await cmd.sys.vfs.ensure<SessionAttrs>(ADMIN_ACCESS, NODE_TYPE_SESSION, dirname(sessionPath), basename(sessionPath), {
    props: { mode: 0o700 },
    attrs: {
      secret: crypto.randomUUID().replaceAll('-', ''),
      access,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      env: {},
    },
  });
  // The settings are read again from the files for the account the shell runs as, as a service's
  // shell's are: the caller's own would be the administrator's.
  const env = Object.fromEntries(Object.entries(cmd.launchEnv).filter(([key]) => !key.startsWith('CFG_')));
  const shell = new Shell({
    cem: cmd.sys.cem,
    vfs: cmd.sys.vfs,
    bufferManager: cmd.sys.bufferManager,
    sessionPath,
    origin: 'system',
    env,
  });
  try {
    await shell.open();
    const result = await shell.runAndCapture(line);
    if (result.stdout) await cmd.write(result.stdout);
    if (result.stderr) await cmd.writeError(result.stderr);
    return result.code;
  } finally {
    await shell.close().catch(() => {});
    await cmd.sys.vfs.unlink(ADMIN_ACCESS, sessionPath, dirname(sessionPath), { recursive: true }).catch(() => {});
  }
};

runas.spec = {
  name: 'runas',
  admin: true,
  effect: 'write' as const,
  json: false,
  description: "Run a command line as another account, with only that account's rights and settings: for a service doing work on someone's behalf",
  args: [
    { name: 'user', type: 'string' as const, description: 'the account, by its username or uid' },
    { name: 'line', type: 'string' as const, description: 'the command line, as one argument or as its words' },
  ],
  examples: ["runas anna 'ls ~'", 'runas anna touch /home/anna/note.txt'],
};
