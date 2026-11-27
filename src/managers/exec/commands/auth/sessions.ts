import { join } from '@std/path';
import { ADMIN_ACCESS, GUEST_GID, GUEST_UID, GUEST_USERNAME } from '../../../../lib/access/mod.ts';
import { signOutShellsOf } from '../../../shell/shell.ts';
import { endSshConnectionsOf } from '../../../../servers/ssh/ssh-server.ts';
import { NODE_TYPE_SESSION, type SessionAttrs } from '../../../../vfs/types/session.ts';
import type { Command } from '../../command.ts';

/**
 * Sign the account `uid` out everywhere: each session node it holds becomes an
 * expired guest session, each open shell acting as it is logged out, each SSH
 * connection signed in as it is ended, and each command still running as it —
 * detached jobs included — is killed. A cookie naming such a session is then
 * refused, and the terminals and API sockets bound to it close when they see
 * the change. Returns how many session nodes were ended. The caller decides who
 * may: the sessions are read and ended as the administrator.
 */
export async function endSessionsOf(cmd: Command, uid: number): Promise<number> {
  return await endSessions(cmd, uid, () => false, true);
}

/**
 * Sign the account `uid` out of every sign-in but the caller's, as `endSessionsOf` does: after its
 * password has changed, a sign-in made with the old one, or a stolen cookie, keeps nothing. A
 * sign-in is a session under `SESSIONS_PATH` or an SSH connection; the caller's own (`cmd.access.sid`)
 * goes on with its shells and commands, and so does what runs as the account outside any sign-in,
 * such as the services the administrator's account runs.
 */
export async function endOtherSessionsOf(cmd: Command, uid: number): Promise<number> {
  const own = cmd.access.sid;
  return await endSessions(cmd, uid, (sid) => sid === own);
}

/**
 * End `uid`'s sign-ins, the shells in them and what they run, but those `spared` keeps by their
 * `sid`; `everything` also reaches the shells and commands outside any sign-in.
 */
async function endSessions(cmd: Command, uid: number, spared: (sid: string | undefined) => boolean, everything = false): Promise<number> {
  const sessionsPath = cmd.env.SESSIONS_PATH;
  const sessions = await cmd.sys.vfs.children<SessionAttrs>(ADMIN_ACCESS, sessionsPath);
  // What the ended sign-ins' commands are named by: a session's node name, or the `sid` its access
  // was given (an SSH connection's).
  const ended = new Set<string>();
  let count = 0;

  for (const entry of sessions) {
    if (entry.node.type !== NODE_TYPE_SESSION || entry.node.attrs.access?.uid !== uid) {
      continue;
    }
    const sids = [entry.name, entry.node.attrs.access.sid].filter((sid): sid is string => !!sid);
    if (sids.some(spared)) {
      continue;
    }

    await cmd.sys.vfs.update<SessionAttrs>(ADMIN_ACCESS, join(sessionsPath, entry.name), {
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
    for (const sid of sids) ended.add(sid);
    count++;
  }

  const signedIn = (sessionPath: string) => sessionPath.startsWith(`${sessionsPath}/`);
  await signOutShellsOf(uid, (access, sessionPath) => {
    if (spared(access.sid) || (!everything && !signedIn(sessionPath))) return false;
    if (access.sid) ended.add(access.sid);
    return true;
  });
  endSshConnectionsOf(uid, (access) => {
    if (spared(access.sid)) return false;
    if (access.sid) ended.add(access.sid);
    return true;
  });
  // A job meant to outlive its owner's access belongs to a service account,
  // not to the account being signed out, so detached jobs are no exception.
  await cmd.sys.cem.signalUid(uid, 'SIGKILL', { where: (access) => everything || (access.sid !== undefined && ended.has(access.sid)) });
  return count;
}
