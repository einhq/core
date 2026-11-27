/**
 * invitation — tokens that open stream and socket nodes over a WebSocket to someone with no account here.
 *
 *   invitation create --read|--write|--connect <path>… [--expires <date>]   make one; it expires in 24 hours unless told
 *   invitation list                                                        the invitations you made, every one for an administrator
 *   invitation remove <id>                                                 turn one off
 *   invitation reap                                                        remove every expired one
 *
 * An invitation names stream nodes, each to read or to write, and socket nodes to connect to.
 * Whoever holds its token opens them with a WebSocket at `/file/<path>?mode=r|w|rw&invite=<token>`,
 * from a page of any origin and without signing in, and reads what `GET /__invite/<token>` lists. The nodes are opened with the creator's
 * access as it is then, so it never reaches more than they do; it ends when it expires, is turned
 * off (which closes its open sockets too), or its creator's account is gone. Only the token's hash is
 * kept: the link is given once, when it is made.
 */

import { resolve } from '@std/path';
import { parseArgs } from '../../../../../lib/args/mod.ts';
import { ADMIN_ACCESS, isAdmin, isVisitor, verifyAccess } from '../../../../../lib/access/mod.ts';
import type { Invitation, InvitationCreated } from '../../../../../lib/api/invitation.ts';
import {
  allInvitations,
  DEFAULT_INVITATION_HOURS,
  invitationId,
  invitationNodes,
  isInvitationExpired,
  MAX_INVITATION_DAYS,
  MAX_INVITATION_NODES,
  readInvitation,
  removeInvitation,
  tokenHash,
} from '../../../../../lib/invitations/mod.ts';
import { INVITATIONS_PATH } from '../../../../../lib/paths.ts';
import { newToken } from '../../../../../lib/token/mod.ts';
import { type InvitationAttrs, type InvitationMode, NODE_TYPE_INVITATION } from '../../../../../vfs/types/invitation.ts';
import { NODE_TYPE_SOCKET } from '../../../../../vfs/types/socket.ts';
import { NODE_TYPE_STREAM } from '../../../../../vfs/types/stream.ts';
import type { Command } from '../../../command.ts';
import type { CmdReturn } from '../../../types.ts';
import { userNames } from './links.ts';

const USAGE = 'Usage: invitation <create|list|remove|reap> [--read <path>] [--write <path>] [--connect <path>] [--expires <date>] [<id>]';

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** When a new invitation expires: `--expires`, a date or epoch ms in the next `MAX_INVITATION_DAYS`, else in `DEFAULT_INVITATION_HOURS`. */
const parseExpiry = (expires: string | undefined, now: number): number => {
  if (expires === undefined) return now + DEFAULT_INVITATION_HOURS * HOUR_MS;
  const at = /^\d+$/.test(expires) ? Number(expires) : Date.parse(expires);
  if (!Number.isFinite(at)) throw new Error(`--expires takes a date or epoch milliseconds, not '${expires}'`);
  if (at <= now) throw new Error('--expires has to be in the future');
  if (at > now + MAX_INVITATION_DAYS * DAY_MS) throw new Error(`--expires is at most ${MAX_INVITATION_DAYS} days away`);
  return at;
};

/** An invitation as the commands answer about it. */
const describe = async (cmd: Command, id: string, attrs: InvitationAttrs, names: Map<number, string>): Promise<Invitation> => ({
  id,
  nodes: await invitationNodes(cmd.sys.vfs, attrs),
  createdBy: { uid: attrs.createdBy, ...(names.has(attrs.createdBy) ? { name: names.get(attrs.createdBy) } : {}) },
  createdAt: attrs.createdAt,
  expiresAt: attrs.expiresAt,
  opened: attrs.opened,
  ...(attrs.lastOpenedAt !== undefined ? { lastOpenedAt: attrs.lastOpenedAt } : {}),
});

const nodesText = (invitation: Invitation): string => invitation.nodes.map((node) => `${node.mode} ${node.path}`).join(', ');

export const invitation = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, { string: ['expires'], collect: ['read', 'write', 'connect'] });
  const [sub, arg] = flags._.map(String);
  const fail = async (message: string): Promise<number> => {
    await cmd.writeError(`invitation: ${message}\n`);
    return 1;
  };

  if (!sub) return await fail(USAGE);
  if (isVisitor(cmd.access)) return await fail('sign in first: an invitation opens nodes as the account that makes it');

  try {
    if (sub === 'create') {
      const asked: { path: string; mode: InvitationMode }[] = [
        ...((flags.read as string[] | undefined) ?? []).map((path) => ({ path: resolve(cmd.cwd, path), mode: 'r' as const })),
        ...((flags.write as string[] | undefined) ?? []).map((path) => ({ path: resolve(cmd.cwd, path), mode: 'w' as const })),
        ...((flags.connect as string[] | undefined) ?? []).map((path) => ({ path: resolve(cmd.cwd, path), mode: 'rw' as const })),
      ];
      if (asked.length === 0) return await fail('create needs the nodes it opens: --read <path>, --write <path> and --connect <path>');
      if (asked.length > MAX_INVITATION_NODES) return await fail(`an invitation opens at most ${MAX_INVITATION_NODES} nodes`);

      const nodes: InvitationAttrs['nodes'] = [];
      for (const { path, mode } of asked) {
        const node = await cmd.sys.vfs.get(cmd.access, path);
        if (node.type === NODE_TYPE_SOCKET && mode !== 'rw') return await fail(`${path}: a socket is connected to: --connect ${path}`);
        if (node.type === NODE_TYPE_STREAM && mode === 'rw') return await fail(`${path}: a stream is read or written: --read or --write ${path}`);
        if (node.type !== NODE_TYPE_STREAM && node.type !== NODE_TYPE_SOCKET) {
          return await fail(`${path}: an invitation opens stream and socket nodes, and this is a ${node.type}`);
        }
        const may = mode === 'rw' ? verifyAccess(cmd.access, node.props, 'r') && verifyAccess(cmd.access, node.props, 'w') : verifyAccess(cmd.access, node.props, mode);
        if (!may) return await fail(`${path}: you may not ${mode === 'r' ? 'read' : mode === 'w' ? 'write' : 'read and write'} it, so no invitation of yours may`);
        if (!nodes.some((known) => known.id === node.id && known.mode === mode)) nodes.push({ id: node.id, mode });
      }

      const now = Date.now();
      const token = newToken();
      const hash = await tokenHash(token);
      const id = invitationId(hash);
      const attrs: InvitationAttrs = { hash, nodes, createdBy: cmd.access.uid, createdAt: now, expiresAt: parseExpiry(flags.expires, now), opened: 0 };
      await cmd.sys.vfs.create<InvitationAttrs>(ADMIN_ACCESS, NODE_TYPE_INVITATION, INVITATIONS_PATH, id, { props: { mode: 0o600 }, attrs });

      const created: InvitationCreated = {
        ...await describe(cmd, id, attrs, await userNames(cmd.sys.vfs, cmd.env.USERS_PATH)),
        token,
        link: `/__invite/${token}`,
      };
      if (cmd.json) await cmd.writeJSON(created satisfies InvitationCreated);
      else await cmd.writeLn(`${created.link}  opens ${nodesText(created)} until ${new Date(created.expiresAt).toISOString()}`);
      return 0;
    }

    if (sub === 'list') {
      const names = await userNames(cmd.sys.vfs, cmd.env.USERS_PATH);
      const invitations: Invitation[] = [];
      for (const { id, node } of await allInvitations(cmd.sys.vfs)) {
        if (node.attrs.createdBy !== cmd.access.uid && !isAdmin(cmd.access)) continue;
        invitations.push(await describe(cmd, id, node.attrs, names));
      }
      invitations.sort((a, b) => b.createdAt - a.createdAt);

      if (cmd.json) await cmd.writeJSON(invitations satisfies Invitation[]);
      else {
        for (const item of invitations) {
          await cmd.writeLn(`${item.id}  ${nodesText(item) || '(its nodes are gone)'}  expires ${new Date(item.expiresAt).toISOString()}  opened ${item.opened}`);
        }
      }
      return 0;
    }

    if (sub === 'remove') {
      if (!arg) return await fail("remove needs an invitation's id");
      const record = await readInvitation(cmd.sys.vfs, arg);
      if (!record || (record.attrs.createdBy !== cmd.access.uid && !isAdmin(cmd.access))) return await fail(`${arg}: no such invitation of yours`);
      await removeInvitation(cmd.sys.vfs, arg);
      if (cmd.json) await cmd.writeJSON({ ok: true, id: arg });
      else await cmd.writeLn(`Turned off ${arg}`);
      return 0;
    }

    if (sub === 'reap') {
      if (!isAdmin(cmd.access)) return await fail('reap removes every expired invitation, which only an administrator may');
      const now = Date.now();
      let removed = 0;
      for (const { id, node } of await allInvitations(cmd.sys.vfs)) {
        if (!isInvitationExpired(node.attrs, now)) continue;
        await removeInvitation(cmd.sys.vfs, id, 'the invitation has expired');
        removed++;
      }
      if (cmd.json) await cmd.writeJSON({ ok: true, removed });
      else if (removed > 0) await cmd.writeLn(`Removed ${removed} expired invitation(s)`);
      return 0;
    }

    return await fail(`unknown subcommand '${sub}'\n${USAGE}`);
  } catch (error) {
    return await fail(error instanceof Error ? error.message : String(error));
  }
};

invitation.spec = {
  name: 'invitation',
  effect: 'read' as const,
  description: 'Make, list and turn off invitations: tokens that open stream and socket nodes over a WebSocket to someone with no account here',
  args: [
    { name: 'subcommand', type: 'string' as const, writes: ['create', 'remove', 'reap'], description: 'create | list | remove | reap' },
    { name: 'id', type: 'string' as const, description: "remove: the invitation's id" },
  ],
  flags: [
    { name: 'read', type: 'path' as const, description: 'create: a stream node it opens to read; may be given several times' },
    { name: 'write', type: 'path' as const, description: 'create: a stream node it opens to write; may be given several times' },
    { name: 'connect', type: 'path' as const, description: 'create: a socket node it connects to; may be given several times' },
    {
      name: 'expires',
      type: 'string' as const,
      description: `create: when it stops, a date or epoch ms, at most ${MAX_INVITATION_DAYS} days away (default: in ${DEFAULT_INVITATION_HOURS} hours)`,
    },
  ],
  examples: [
    'invitation create --connect /groups/club/board/socket --expires 2026-12-24',
    'invitation create --read /groups/club/scores --expires 2026-12-24',
    'invitation list',
    'invitation remove 0123456789abcdef',
  ],
  returns: 'create: the invitation with its token and link, once (InvitationCreated); list: Invitation[]; remove and reap: { ok }.',
};
