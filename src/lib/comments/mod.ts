/**
 * Comments: markdown files on the `db` storage tier under `<owner>/comments/<slug>`.
 * The body is the file content, the author is `props.uid` and the time
 * `props.birthtime`. Owners are any node (files, albums, people).
 *
 * The `comment` command writes them; reading is here, apart from it, because modules read
 * comments too and the module contract must not reach the exec manager.
 */

import { toText } from '@std/streams/to-text';
import { ADMIN_ACCESS } from '../access/mod.ts';
import { NODE_TYPE_FILE } from '../../vfs/types/file.ts';
import type { UserAttrs } from '../../vfs/types/user.ts';
import type { VfsCommand } from '../vfs-command.ts';
import type { CommentEntry } from '../api/comments.ts';
export type { CommentEntry } from '../api/comments.ts';

export const COMMENTS_DIR = 'comments';
export const COMMENT_MIMETYPE = 'text/markdown';

type CommentAuthor = { username: string; name?: string; personPath?: string };

/**
 * The accounts of `uids`, by uid: each one's username, full name and the person it is linked to. A uid with
 * no account, or every uid when the users directory cannot be read, is left out.
 */
export const commentAuthors = async (cmd: VfsCommand, uids: Iterable<number>): Promise<Map<number, CommentAuthor>> => {
  const wanted = new Set(uids);
  let users;
  try {
    users = (await cmd.sys.vfs.children<UserAttrs>(cmd.access, cmd.env.USERS_PATH)).filter((u) => wanted.has(u.node.attrs.uid));
  } catch {
    return new Map();
  }
  // The `person` link is the account's, read as the administrator; the person itself is read by
  // whoever shows it, with their own access.
  return new Map(
    await Promise.all(users.map(async (u) => {
      const personPath = await cmd.sys.vfs.get(ADMIN_ACCESS, `${cmd.env.USERS_PATH}/${u.name}/person`, { follow: false })
        .then((link) => link.props.softlink || undefined, () => undefined);
      const name = u.node.attrs.name?.trim() || undefined;
      return [u.node.attrs.uid, { username: u.name, ...(name ? { name } : {}), ...(personPath ? { personPath } : {}) }] as const;
    })),
  );
};

const toMillis = (ts: number | string | undefined): number => {
  const n = Number(ts);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
};

/**
 * Read every comment on a node, oldest first. Missing `comments` directory or
 * an unreadable body yields fewer entries rather than an error — callers embed
 * this in larger read aggregates.
 */
export const readComments = async (cmd: VfsCommand, path: string): Promise<CommentEntry[]> => {
  const dir = `${path}/${COMMENTS_DIR}`;
  let children;
  try {
    children = await cmd.sys.vfs.children(cmd.access, dir);
  } catch {
    return [];
  }

  const entries: CommentEntry[] = [];

  for (const child of children) {
    if (child.node.type !== NODE_TYPE_FILE) continue;
    let body = '';
    try {
      const handle = await cmd.sys.vfs.open(cmd.access, `${dir}/${child.name}`, { mode: 'r' });
      try {
        body = await toText(handle.readable);
      } finally {
        await handle.close();
      }
    } catch {
      continue;
    }
    const uid = child.node.props.birthtime?.uid ?? child.node.props.uid;
    entries.push({ slug: child.name, body, uid, author: String(uid), createdAt: toMillis(child.node.props.birthtime?.timestamp) });
  }

  const authors = await commentAuthors(cmd, entries.map((e) => e.uid));
  for (const entry of entries) {
    const author = authors.get(entry.uid);
    if (!author) continue;
    entry.author = author.username;
    if (author.name) entry.authorName = author.name;
    if (author.personPath) entry.personPath = author.personPath;
  }

  entries.sort((a, b) => a.createdAt - b.createdAt);
  return entries;
};
