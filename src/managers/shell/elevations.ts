import { join } from '@std/path';
import { ADMIN_ACCESS } from '../../lib/access/mod.ts';
import { SUDO_GROUPNAME } from '../../lib/access/constants.ts';
import { isMemberOf } from '../../lib/auth/member-gids.ts';
import { GROUPS_PATH, SESSIONS_PATH, USERS_PATH } from '../../lib/paths.ts';
import type { NodeVFS } from '../../vfs/mod.ts';
import type { EventSubscription } from '../../vfs/types.ts';
import { NODE_TYPE_SESSION, type SessionAttrs } from '../../vfs/types/session.ts';
import { isUserNode, NODE_TYPE_USER, type UserAttrs } from '../../vfs/types/user.ts';
import type { ExecutionManager } from '../exec/execution-manager.ts';
import { createLogger } from '../logger/mod.ts';
import { openShellList, unelevateShellsOf } from './shell.ts';

const logger = createLogger('elevations');

/**
 * Keep every elevation (`user-elevate`) to accounts in the `sudo` group: after any change under
 * `GROUPS_PATH` — a membership link removed or moved by hand as much as by `group-remove-member`,
 * the group itself renamed or deleted — and after any change to a user node, such as its primary
 * group, each account still holding an elevation is checked against the group as it is now, and
 * loses it when it is no longer a member. Handlers run before the write that triggered them
 * returns, so the change is in force by then. Returns the subscriptions to end on dispose.
 */
export async function watchElevations(vfs: NodeVFS, cem: ExecutionManager): Promise<EventSubscription[]> {
  if (!vfs.subscribe) return [];
  const recheck = () => dropLapsedElevations(vfs, cem).catch((error) => logger.error('checking elevations failed', { error: (error as Error).message }));
  return [
    await vfs.subscribe(() => ADMIN_ACCESS, recheck, { pathPrefix: GROUPS_PATH, recursive: true }),
    await vfs.subscribe(() => ADMIN_ACCESS, recheck, {
      pathPrefix: USERS_PATH,
      recursive: false,
      nodeTypes: [NODE_TYPE_USER],
      eventTypes: ['updated', 'deleted', 'moved'],
    }),
  ];
}

/** Drop the elevations of every account that holds one and is no longer in `sudo`. */
async function dropLapsedElevations(vfs: NodeVFS, cem: ExecutionManager): Promise<void> {
  const uids = await elevatedUids(vfs, cem);
  if (uids.size === 0) return;

  const users = await vfs.children<UserAttrs>(ADMIN_ACCESS, USERS_PATH);
  for (const uid of uids) {
    const account = users.find((entry) => isUserNode(entry.node) && entry.node.attrs.uid === uid);
    if (account && await isMemberOf(vfs, ADMIN_ACCESS, SUDO_GROUPNAME, account.name, account.node)) continue;
    logger.info('elevation ended: no longer in the sudo group', { uid });
    await dropElevationOf(vfs, cem, uid);
  }
}

/** The accounts with an elevated session, shell or running command. */
async function elevatedUids(vfs: NodeVFS, cem: ExecutionManager): Promise<Set<number>> {
  const uids = new Set<number>();
  for (const shell of openShellList()) {
    if (shell.access.elevated === true) uids.add(shell.access.uid);
  }
  for (const state of cem.states()) {
    if (state.state === 'running' && state.opts?.access.elevated === true) uids.add(state.opts.access.uid);
  }
  for (const entry of await vfs.children<SessionAttrs>(ADMIN_ACCESS, SESSIONS_PATH)) {
    if (entry.node.type === NODE_TYPE_SESSION && entry.node.attrs.access?.elevated === true) uids.add(entry.node.attrs.access.uid);
  }
  return uids;
}

/**
 * Take back every elevation of the account `uid`: its sessions and the shells acting as it are no
 * longer an administrator's, and each command it started elevated and is still running — detached
 * jobs included — is killed.
 */
async function dropElevationOf(vfs: NodeVFS, cem: ExecutionManager, uid: number): Promise<void> {
  for (const entry of await vfs.children<SessionAttrs>(ADMIN_ACCESS, SESSIONS_PATH)) {
    if (entry.node.type !== NODE_TYPE_SESSION || entry.node.attrs.access?.uid !== uid || entry.node.attrs.access.elevated !== true) {
      continue;
    }
    const { elevated: _, ...access } = entry.node.attrs.access;
    await vfs.update<SessionAttrs>(ADMIN_ACCESS, join(SESSIONS_PATH, entry.name), { attrs: { access } });
  }

  await unelevateShellsOf(uid);
  await cem.signalUid(uid, 'SIGKILL', { elevated: true });
}
