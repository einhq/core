import { decodeTime, ulid } from '@std/ulid';
import { type Access, ADMIN_ACCESS, GUEST_ACCESS, isAdmin, verifyAccess } from '../../../../lib/access/mod.ts';
import type { ReachCheck, ReachMismatch } from '../../../../lib/api/mod.ts';
import { parseArgs } from '../../../../lib/args/mod.ts';
import { userAccess } from '../../../../lib/auth/member-gids.ts';
import { GROUPS_PATH, LINKS_PATH, USERS_PATH } from '../../../../lib/paths.ts';
import type { NodeId } from '../../../../vfs/mod.ts';
import type { GroupAttrs } from '../../../../vfs/types/group.ts';
import { isShareLinkNode } from '../../../../vfs/types/share-link.ts';
import { isUserNode, type UserAttrs } from '../../../../vfs/types/user.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

/** Places in the id order a sample is read from, `--sample` divided among them. */
const CURSORS = 20;

/**
 * Checks stored reach against the rule it stands for: a sample of nodes, read from random places
 * in id order, is judged for every account, the guest and every share link both by `getNodesByIds`
 * (stored reach) and by `resolveIdEntries` (a walk of each path) with the node's own read, and the
 * two must agree. Nodes without a path an administrator can follow (in a trash, or detached) are
 * left out. Also lists the uids and gids reach still names that no account, link or group holds.
 */
export const reachCheck = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, { string: ['sample'] });
  const fail = async (message: string) => {
    if (cmd.json) await cmd.writeJSON({ error: `reach-check: ${message}` });
    else await cmd.writeError(`reach-check: ${message}\n`);
    return 1;
  };
  if (!isAdmin(cmd.access)) return await fail('administrators only');
  const sample = Number(flags.sample ?? 2000);
  if (!Number.isInteger(sample) || sample <= 0) return await fail(`--sample takes a positive number, not ${flags.sample}`);
  const vfs = cmd.sys.vfs;

  const users = (await vfs.children<UserAttrs>(ADMIN_ACCESS, USERS_PATH)).filter((entry) => isUserNode(entry.node));
  const links = (await vfs.children(ADMIN_ACCESS, LINKS_PATH).catch(() => [])).map((entry) => entry.node).filter(isShareLinkNode);
  const groups = await vfs.children<GroupAttrs>(ADMIN_ACCESS, GROUPS_PATH);
  const callers: Access[] = [
    GUEST_ACCESS,
    ...await Promise.all(users.map((entry) => userAccess(vfs, ADMIN_ACCESS, entry.name, entry.node))),
    ...links.map((link): Access => ({
      uid: link.attrs.uid,
      gid: link.attrs.uid,
      gids: [],
      link: { id: link.id, ...(link.attrs.expiresAt !== undefined ? { expiresAt: link.attrs.expiresAt } : {}) },
    })),
  ];

  // Random places between the first id and now; each read takes the ids that follow it.
  const first = (await vfs.query(ADMIN_ACCESS, { limit: 1 }))[0]?.id;
  const ids = new Set<NodeId>();
  if (first !== undefined) {
    const from = decodeTime(first);
    for (let i = 0; i < CURSORS; i++) {
      const after = ulid(from + Math.floor(Math.random() * (Date.now() - from)));
      for (const entry of await vfs.query(ADMIN_ACCESS, { limit: Math.ceil(sample / CURSORS), after: { value: null, id: after } })) ids.add(entry.id);
    }
  }
  const sampled = [...ids];
  const nodes = await vfs.getNodesByIds(ADMIN_ACCESS, sampled);
  const paths = await vfs.resolveIdEntries(ADMIN_ACCESS, sampled);
  const judged = sampled.filter((id) => nodes.has(id) && (paths.get(id)?.length ?? 0) > 0);

  const mismatches: ReachMismatch[] = [];
  for (const access of callers) {
    const byReach = await vfs.getNodesByIds(access, judged);
    const byPath = await vfs.resolveIdEntries(access, judged);
    for (const id of judged) {
      const reached = byReach.has(id);
      const walked = (byPath.get(id)?.length ?? 0) > 0 && verifyAccess(access, nodes.get(id)!.props, 'r');
      if (reached !== walked) mismatches.push({ id, path: paths.get(id)![0].path, uid: access.uid, byReach: reached, byPath: walked });
    }
  }

  const named = await vfs.reachNamed(ADMIN_ACCESS);
  const uids = new Set([ADMIN_ACCESS.uid, GUEST_ACCESS.uid, ...users.map((entry) => entry.node.attrs.uid), ...links.map((link) => link.attrs.uid)]);
  const gids = new Set([...ADMIN_ACCESS.gids, ...GUEST_ACCESS.gids, ...callers.flatMap((access) => access.gids), ...groups.map((entry) => entry.node.attrs.gid)]);
  const unknown = { uids: named.uids.filter((uid) => !uids.has(uid)), gids: named.gids.filter((gid) => !gids.has(gid)) };

  const result = { sampled: judged.length, callers: callers.length, mismatches, unknown } satisfies ReachCheck;
  if (cmd.json) {
    await cmd.writeJSON(result);
  } else {
    await cmd.write(`${result.sampled} nodes judged for ${result.callers} callers: ${mismatches.length} disagree\n`);
    for (const m of mismatches) await cmd.write(`  ${m.id}\t${m.path}\tuid ${m.uid}\treach ${m.byReach ? 'yes' : 'no'}, path ${m.byPath ? 'yes' : 'no'}\n`);
    if (unknown.uids.length > 0) await cmd.write(`reach names uids no account or link holds: ${unknown.uids.join(' ')}\n`);
    if (unknown.gids.length > 0) await cmd.write(`reach names gids no group holds: ${unknown.gids.join(' ')}\n`);
  }
  return mismatches.length === 0 && unknown.uids.length === 0 && unknown.gids.length === 0 ? 0 : 1;
};

reachCheck.spec = {
  name: 'reach-check',
  effect: 'read' as const,
  description: 'Check stored reach against a walk of each path, for a sample of nodes and every account',
  args: [],
  flags: [
    { name: 'sample', type: 'string' as const, description: 'how many nodes to judge (default 2000)' },
  ],
};
