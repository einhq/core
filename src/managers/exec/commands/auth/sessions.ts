import { join } from '@std/path';
import { GUEST_GID, GUEST_UID, GUEST_USERNAME } from '../../../../lib/access/mod.ts';
import { signOutShellsOf } from '../../../shell/shell.ts';
import { NODE_TYPE_SESSION, type SessionAttrs } from '../../../../vfs/types/session.ts';
import type { Command } from '../../command.ts';

/**
 * Sign the account `uid` out everywhere: each session node it holds becomes an
 * expired guest session, each open shell acting as it is logged out, and each
 * command still running as it — detached jobs included — is killed. A cookie
 * naming such a session is then refused, and the terminals and API sockets
 * bound to it close when they see the change. Returns how many sessions were
 * ended.
 */
export async function endSessionsOf(cmd: Command, uid: number): Promise<number> {
  const sessionsPath = cmd.env.SESSIONS_PATH;
  const sessions = await cmd.sys.vfs.children<SessionAttrs>(cmd.access, sessionsPath);
  let ended = 0;

  for (const entry of sessions) {
    if (entry.node.type !== NODE_TYPE_SESSION || entry.node.attrs.access?.uid !== uid) {
      continue;
    }

    await cmd.sys.vfs.update<SessionAttrs>(cmd.access, join(sessionsPath, entry.name), {
      attrs: {
        expired: true,
        access: { uid: GUEST_UID, gid: GUEST_GID, gids: [GUEST_GID] },
        env: {
          ...(entry.node.attrs.env || {}),
          USER: GUEST_USERNAME,
          HOME: join(cmd.env.HOMES_PATH, GUEST_USERNAME),
          UID: String(GUEST_UID),
          GID: String(GUEST_GID),
          SID: '',
        },
      },
    });
    ended++;
  }

  await signOutShellsOf(uid);
  // A job meant to outlive its owner's access belongs to a service account,
  // not to the account being disabled, so detached jobs are no exception.
  await cmd.sys.cem.signalUid(uid, 'SIGKILL');
  return ended;
}
