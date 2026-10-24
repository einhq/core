/**
 * Comments: markdown files on the `db` storage tier under `<owner>/comments/<slug>`.
 * The body is the file content, the author is `props.uid` and the time
 * `props.birthtime`. Owners are any node (files, albums, people).
 */

import { decodeBase64 } from '@std/encoding/base64';
import { resolve } from '@std/path';
import { ulid } from '@std/ulid';
import { isAdmin } from '../../../../lib/access/mod.ts';
import { parseArgs } from '../../../../lib/args/mod.ts';
import { NODE_TYPE_DIRECTORY } from '../../../../vfs/types/directory.ts';
import { NODE_TYPE_FILE } from '../../../../vfs/types/file.ts';
import type { Command } from '../../command.ts';
import type { CmdReturn } from '../../types.ts';

import { COMMENT_MIMETYPE, COMMENTS_DIR, readComments, usernames } from '../../../../lib/comments/mod.ts';

const USAGE = 'Usage: comment <list|add|remove> <path> [--body <text> | --body-base64 <b64>] [<slug>]';

const commentList = async (cmd: Command, path: string): Promise<number> => {
  const entries = await readComments(cmd, path);
  if (cmd.json) {
    await cmd.writeJSON(entries);
  } else {
    for (const e of entries) {
      await cmd.writeLn(`${e.author} (${new Date(e.createdAt).toISOString()}) [${e.slug}]`);
      await cmd.writeLn(e.body);
    }
  }
  return 0;
};

const commentAdd = async (cmd: Command, path: string, body: string): Promise<number> => {
  if (!body.trim()) {
    await cmd.writeError('comment: empty body\n');
    return 1;
  }
  if (!(await cmd.sys.vfs.exists(cmd.access, path))) {
    await cmd.writeError(`comment: ${path}: not found\n`);
    return 1;
  }

  const bytes = new TextEncoder().encode(body);
  const slug = ulid();
  const uid = cmd.access.uid;

  await cmd.sys.vfs.ensure(cmd.access, NODE_TYPE_DIRECTORY, path, COMMENTS_DIR);
  await cmd.sys.vfs.create(cmd.access, NODE_TYPE_FILE, `${path}/${COMMENTS_DIR}`, slug, {
    props: { uid, mode: 0o664, tier: 'db' },
    attrs: { name: slug, mimetype: COMMENT_MIMETYPE, size: bytes.length },
  });

  const handle = await cmd.sys.vfs.open(cmd.access, `${path}/${COMMENTS_DIR}/${slug}`, { mode: 'w' });
  try {
    await handle.write(bytes);
  } finally {
    await handle.close();
  }

  if (cmd.json) {
    const names = await usernames(cmd);
    await cmd.writeJSON({ slug, body, uid, author: names.get(uid) ?? String(uid), createdAt: Date.now() });
  } else {
    await cmd.writeLn(`Added comment ${slug} on ${path}`);
  }
  return 0;
};

const commentRemove = async (cmd: Command, path: string, slug: string): Promise<number> => {
  const dir = `${path}/${COMMENTS_DIR}`;
  const commentPath = `${dir}/${slug}`;

  const node = await cmd.sys.vfs.get(cmd.access, commentPath);
  const owner = node.props.birthtime?.uid ?? node.props.uid;
  // The comments directory is group-writable, so ownership is checked here.
  if (!isAdmin(cmd.access) && cmd.access.uid !== owner) {
    await cmd.writeError(`comment: ${commentPath}: not your comment\n`);
    return 1;
  }

  await cmd.sys.vfs.unlink(cmd.access, commentPath, dir);
  if (cmd.json) {
    await cmd.writeJSON({ ok: true });
  } else {
    await cmd.writeLn(`Removed comment ${slug} from ${path}`);
  }
  return 0;
};

export const comment = async (cmd: Command): CmdReturn => {
  const flags = parseArgs(cmd.args, { string: ['body', 'body-base64'] });
  const [sub, pathArg, slugArg] = flags._;

  if (!sub || !pathArg) {
    await cmd.writeError(`${USAGE}\n`);
    return 1;
  }
  const path = resolve(cmd.cwd, pathArg);

  try {
    switch (sub) {
      case 'list':
        return await commentList(cmd, path);
      case 'add': {
        const encoded = flags['body-base64'];
        const body = encoded ? new TextDecoder().decode(decodeBase64(encoded)) : (flags.body ?? '');
        return await commentAdd(cmd, path, body);
      }
      case 'remove': {
        if (!slugArg) {
          await cmd.writeError(`${USAGE}\n`);
          return 1;
        }
        return await commentRemove(cmd, path, slugArg);
      }
      default:
        await cmd.writeError(`${USAGE}\n`);
        return 1;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await cmd.writeError(`comment: ${message}\n`);
    return 1;
  }
};

comment.spec = {
  name: 'comment',
  effect: 'read' as const,
  description: 'Manage comments on a node (list, add, remove)',
  args: [
    { name: 'subcommand', writes: ['add', 'remove'], type: 'string' as const, description: 'list | add | remove' },
    { name: 'path', type: 'path' as const, description: 'node the comment belongs to' },
    { name: 'slug', type: 'string' as const, description: 'comment slug (remove)' },
  ],
  flags: [
    { name: 'body', type: 'string' as const, description: 'comment body (add)' },
    { name: 'body-base64', type: 'string' as const, description: 'base64-encoded comment body (add)' },
  ],
};
