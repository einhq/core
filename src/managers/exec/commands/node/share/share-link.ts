/**
 * share-link — links that open a node, and everything below it, without signing in.
 *
 *   share-link create <path> [--expires <date>|--never]   make one; it expires in 30 days unless told
 *   share-link list [<path>]                              a node's links, or every link you made
 *   share-link set <id> --expires <date>|--never          change when one expires
 *   share-link remove <id>                                turn one off
 *   share-link open <token> [--session]                   hold the link the token names
 *   share-link reap                                       turn off every expired link
 *
 * A link is a principal of its own: a uid from `LINK_UID_BASE` up, with no account, granted
 * `u:<uid>:r-x` on the node and on everything below it that its creator may change, and a record
 * under `/var/links` saying who it is, what it opens, until when, and how often it was opened.
 * Someone who has not signed in and opens one acts as its uid — with `--session`, their whole
 * session — in place of any link opened before, so they read what this one opens and nothing
 * else; someone signed in stays themselves. Turning one off releases its uid from every node,
 * wherever they went since, and sends whoever acts as it back to the guest.
 */

import { join, resolve } from '@std/path';
import { parseArgs } from '../../../../../lib/args/mod.ts';
import { ADMIN_ACCESS, ADMIN_UID, isAdmin, isVisitor, verifyAccess } from '../../../../../lib/access/mod.ts';
import type { ShareLink, ShareLinkCreated, ShareLinkOpened } from '../../../../../lib/api/share.ts';
import { NODE_TYPE_SHARE_LINK, type ShareLinkAttrs } from '../../../../../vfs/types/share-link.ts';
import type { Command } from '../../../command.ts';
import type { CmdReturn } from '../../../types.ts';
import {
  allLinks,
  DEFAULT_LINK_DAYS,
  describeLink,
  heldLink,
  isExpired,
  isToken,
  LINK_MODE,
  linkAccess,
  linkId,
  newLinkUid,
  newToken,
  readLink,
  sameToken,
  targetPath,
  titleOf,
  updateHeld,
  userNames,
} from './links.ts';
import { applySubtree } from './walk.ts';

const USAGE = 'Usage: share-link <create|list|set|remove|open|reap> [<path>|<id>|<token>] [--expires <date>|--never] [--session]';

const DAY_MS = 24 * 60 * 60 * 1000;

/** What `--expires` or `--never` ask for: epoch ms, null for no expiry, undefined when neither is given. */
const parseExpiry = (flags: { expires?: string; never?: boolean }): number | null | undefined => {
  if (flags.never) return null;
  if (flags.expires === undefined) return undefined;
  const at = /^\d+$/.test(flags.expires) ? Number(flags.expires) : Date.parse(flags.expires);
  if (!Number.isFinite(at)) throw new Error(`--expires takes a date or epoch milliseconds, not '${flags.expires}'`);
  if (at <= Date.now()) throw new Error('--expires has to be in the future');
  return at;
};

/**
 * Turn a link off: its uid off every node, its record gone, and every session and shell acting as
 * it the guest again.
 */
const removeLink = async (cmd: Command, id: string, uid: number): Promise<number> => {
  const released = await cmd.sys.vfs.releaseOwner(ADMIN_ACCESS, { kind: 'uid', id: uid, to: ADMIN_UID });
  await cmd.sys.vfs.unlink(ADMIN_ACCESS, join(cmd.env.LINKS_PATH, id), cmd.env.LINKS_PATH);
  await updateHeld(cmd, id);
  return released.acl;
};

/** Whether the caller may change the link `link` opens: whoever may change the node, or, once it is gone, whoever made the link. */
const mayManage = async (cmd: Command, link: ShareLinkAttrs): Promise<boolean> => {
  if (isAdmin(cmd.access)) return true;
  const path = await targetPath(cmd, link);
  if (!path) return link.createdBy === cmd.access.uid;
  const node = await cmd.sys.vfs.get(ADMIN_ACCESS, path).catch(() => undefined);
  return node !== undefined && verifyAccess(cmd.access, node.props, 'w');
};

export const shareLink = async (cmd: Command): CmdReturn => {
  // '_' keeps the arguments strings: a link id can be all digits, and as a number it loses them.
  const flags = parseArgs(cmd.args, { string: ['expires', '_'], boolean: ['never', 'session'] });
  const [sub, arg] = flags._.map(String);
  const fail = async (message: string): Promise<number> => {
    await cmd.writeError(`share-link: ${message}\n`);
    return 1;
  };

  if (!sub) return await fail(USAGE);

  try {
    if (sub === 'create') {
      if (!arg) return await fail('create needs the path of the node to open');
      const path = resolve(cmd.cwd, arg);
      const node = await cmd.sys.vfs.get(cmd.access, path);
      if (!verifyAccess(cmd.access, node.props, 'w')) return await fail(`${path}: only someone who may change it can share it by link`);

      const expiry = parseExpiry(flags);
      const now = Date.now();
      const expiresAt = expiry === undefined ? now + DEFAULT_LINK_DAYS * DAY_MS : expiry ?? undefined;
      const token = newToken();
      const id = await linkId(token);
      const uid = await newLinkUid(cmd);

      const attrs: ShareLinkAttrs = {
        token,
        uid,
        target: node.id,
        createdBy: cmd.access.uid,
        createdAt: now,
        ...(expiresAt !== undefined ? { expiresAt } : {}),
        opened: 0,
      };
      await cmd.sys.vfs.create<ShareLinkAttrs>(ADMIN_ACCESS, NODE_TYPE_SHARE_LINK, cmd.env.LINKS_PATH, id, { props: { mode: 0o600 }, attrs });

      const interrupt = new AbortController();
      cmd.onInterrupt(() => interrupt.abort());

      let result;
      try {
        // Beside whatever each node lists already; a node that keeps its own sharing is left out
        // with everything below it, and so is one the caller may not change.
        result = await applySubtree(cmd.sys.vfs, cmd.access, path, {
          acl: (current) => [...current.filter((entry) => entry.uid !== uid), { uid, mode: LINK_MODE }],
        }, { recursive: true, signal: interrupt.signal });
      } catch (error) {
        await removeLink(cmd, id, uid);
        throw error;
      }

      const created: ShareLinkCreated = {
        link: describeLink(id, attrs, path, true, await userNames(cmd.sys.vfs, cmd.env.USERS_PATH)),
        updated: result.updated,
        pinned: result.pinned,
        failed: result.failed,
      };
      if (cmd.json) await cmd.writeJSON(created satisfies ShareLinkCreated);
      else await cmd.writeLn(`/s/${token}  opens ${path}${expiresAt ? ` until ${new Date(expiresAt).toISOString()}` : ''}`);
      return 0;
    }

    if (sub === 'list') {
      const names = await userNames(cmd.sys.vfs, cmd.env.USERS_PATH);
      const node = arg ? await cmd.sys.vfs.get(cmd.access, resolve(cmd.cwd, arg)) : undefined;
      const links: ShareLink[] = [];

      for (const entry of await allLinks(cmd)) {
        const link = entry.node.attrs;
        if (node ? link.target !== node.id : link.createdBy !== cmd.access.uid && !isAdmin(cmd.access)) continue;
        const path = await targetPath(cmd, link);
        if (!path) continue;
        links.push(describeLink(entry.name, link, path, await mayManage(cmd, link), names));
      }
      links.sort((a, b) => b.createdAt - a.createdAt);

      if (cmd.json) await cmd.writeJSON(links satisfies ShareLink[]);
      else {
        for (const link of links) {
          const until = link.expiresAt ? new Date(link.expiresAt).toISOString() : 'never';
          await cmd.writeLn(`${link.id}  ${link.path}  expires ${until}  opened ${link.opened}${link.token ? `  /s/${link.token}` : ''}`);
        }
      }
      return 0;
    }

    if (sub === 'set' || sub === 'remove') {
      if (!arg) return await fail(`${sub} needs a link's id`);
      const record = await readLink(cmd, arg);
      if (!record) return await fail(`${arg}: no such link`);
      if (!(await mayManage(cmd, record.attrs))) return await fail(`${arg}: only someone who may change what it opens can change the link`);

      if (sub === 'remove') {
        const cleared = await removeLink(cmd, arg, record.attrs.uid);
        if (cmd.json) await cmd.writeJSON({ ok: true, id: arg, cleared });
        else await cmd.writeLn(`Turned off ${arg}; ${cleared} node(s) no longer open to it`);
        return 0;
      }

      const expiry = parseExpiry(flags);
      if (expiry === undefined) return await fail('set needs --expires <date> or --never');
      const updated = await cmd.sys.vfs.update<ShareLinkAttrs>(ADMIN_ACCESS, join(cmd.env.LINKS_PATH, arg), {
        attrs: { expiresAt: expiry },
      });
      await updateHeld(cmd, arg, heldLink(arg, updated.attrs));

      const link = describeLink(arg, updated.attrs, await targetPath(cmd, updated.attrs) ?? '', true, await userNames(cmd.sys.vfs, cmd.env.USERS_PATH));
      if (cmd.json) await cmd.writeJSON(link satisfies ShareLink);
      else await cmd.writeLn(`${arg} expires ${link.expiresAt ? new Date(link.expiresAt).toISOString() : 'never'}`);
      return 0;
    }

    if (sub === 'open') {
      // One answer for a token that names nothing and one that names an expired link would tell a
      // guesser which tokens once existed; they get the same.
      const dead = 'this link does not open anything any more';
      if (!arg || !isToken(arg)) return await fail(dead);
      const id = await linkId(arg);
      const record = await readLink(cmd, id);
      if (!record || !sameToken(record.attrs.token, arg) || isExpired(record.attrs)) return await fail(dead);

      const path = await targetPath(cmd, record.attrs);
      if (!path) return await fail(dead);
      const node = await cmd.sys.vfs.get(ADMIN_ACCESS, path);

      // Someone signed in stays themselves: what they may see is their own account's to say.
      if (isVisitor(cmd.access)) await cmd.actAsLink(linkAccess(id, record.attrs), flags.session);
      await cmd.sys.vfs.update<ShareLinkAttrs>(ADMIN_ACCESS, join(cmd.env.LINKS_PATH, id), {
        attrs: { opened: record.attrs.opened + 1, lastOpenedAt: Date.now() },
      });

      const opened: ShareLinkOpened = {
        id,
        path,
        type: node.type,
        title: titleOf(node, path),
        ...(record.attrs.expiresAt !== undefined ? { expiresAt: record.attrs.expiresAt } : {}),
      };
      if (cmd.json) await cmd.writeJSON(opened satisfies ShareLinkOpened);
      else await cmd.writeLn(`Opened ${path}`);
      return 0;
    }

    if (sub === 'reap') {
      if (!isAdmin(cmd.access)) return await fail('reap turns off every expired link, which only an administrator may');
      const now = Date.now();
      let removed = 0;
      for (const entry of await allLinks(cmd)) {
        if (!isExpired(entry.node.attrs, now)) continue;
        await removeLink(cmd, entry.name, entry.node.attrs.uid);
        removed++;
      }
      if (cmd.json) await cmd.writeJSON({ ok: true, removed });
      else if (removed > 0) await cmd.writeLn(`Turned off ${removed} expired link(s)`);
      return 0;
    }

    return await fail(`unknown subcommand '${sub}'\n${USAGE}`);
  } catch (error) {
    return await fail(error instanceof Error ? error.message : String(error));
  }
};

shareLink.spec = {
  name: 'share-link',
  guest: true,
  effect: 'read' as const,
  description: 'Make, list, change and turn off links that open a node without signing in',
  args: [
    { name: 'subcommand', type: 'string' as const, writes: ['create', 'set', 'remove', 'open', 'reap'], description: 'create | list | set | remove | open | reap' },
    { name: 'target', type: 'path' as const, description: 'create and list: the node; set and remove: the link id; open: the token' },
  ],
  flags: [
    { name: 'expires', type: 'string' as const, description: 'create and set: when the link stops working, a date or epoch ms (default: 30 days)' },
    { name: 'never', type: 'bool' as const, description: 'create and set: the link does not expire' },
    { name: 'session', type: 'bool' as const, description: 'open: act as the link in the whole session, not just this shell' },
  ],
  examples: ['share-link create /archive/albums/Exempelalbum', 'share-link list /archive/albums/Exempelalbum', 'share-link remove 0123456789abcdef'],
  returns: 'create: the link and how many nodes it reached (ShareLinkCreated); list: ShareLink[]; set: ShareLink; open: what it opens (ShareLinkOpened).',
};
