/**
 * Comments: markdown files on the `db` storage tier under `<owner>/comments/<slug>`.
 * The body is the file content, the author is `props.uid` and the time
 * `props.birthtime`. Owners are any node (files, albums, people).
 *
 * The `comment` command writes them; reading is here, apart from it, because modules read
 * comments too and the module contract must not reach the exec manager.
 */

import { toText } from '@std/streams/to-text';
import { NODE_TYPE_FILE } from '../../vfs/types/file.ts';
import type { UserAttrs } from '../../vfs/types/user.ts';
import type { VfsCommand } from '../vfs-command.ts';
import type { CommentEntry } from '../api/comments.ts';
export type { CommentEntry } from '../api/comments.ts';

export const COMMENTS_DIR = 'comments';
export const COMMENT_MIMETYPE = 'text/markdown';

/** uid -> username, for the author of a comment. Empty when the users directory cannot be read. */
export const usernames = async (cmd: VfsCommand): Promise<Map<number, string>> => {
  try {
    const users = await cmd.sys.vfs.children<UserAttrs>(cmd.access, cmd.env.USERS_PATH);
    return new Map(users.map((u) => [u.node.attrs.uid, u.name]));
  } catch {
    return new Map();
  }
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

  const names = await usernames(cmd);
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
    entries.push({
      slug: child.name,
      body,
      uid,
      author: names.get(uid) ?? String(uid),
      createdAt: toMillis(child.node.props.birthtime?.timestamp),
    });
  }

  entries.sort((a, b) => a.createdAt - b.createdAt);
  return entries;
};
