/**
 * Public-key login to EiN's SSH server: the keys in the user's
 * `~/.ssh/authorized_keys`, as OpenSSH's sshd reads them.
 *
 * Only honoured when nobody but the user (or the admin) could have put a key
 * there — sshd's StrictModes. In EiN that check matters more than on a Unix
 * box: a new node's default mode is group-writable, so an `authorized_keys`
 * created without a `chmod` would let every member of its group in as this
 * user. The home, `~/.ssh` and the file must each be owned by the user or the
 * admin, give no write to group or others, and grant no write by ACL to anyone
 * else; none may be a link.
 *
 * A line with options (`command="…"`, `from="…"`, `no-pty`, …) is skipped:
 * honouring the key while ignoring a `command=` would grant more than the line
 * says.
 */

import { toText } from '@std/streams';
import { type ParsedKey, parseKey } from 'ssh2';
import { ADMIN_ACCESS, ADMIN_UID } from '../../lib/access/mod.ts';
import { checkMode, MaskACL } from '../../lib/mode/mod.ts';
import type { UserId } from '../../lib/mode/mod.ts';
import type { Node } from '../../vfs/node.ts';
import type { NodeVFS } from '../../vfs/node-vfs.ts';
import { NODE_TYPE_DIRECTORY } from '../../vfs/types/directory.ts';
import { NODE_TYPE_FILE } from '../../vfs/types/file.ts';

type AuthorizedKeyResult =
  /** The key is listed */
  | { key: ParsedKey }
  /** Keys are not honoured for this user; `reason` is for the log */
  | { refused: string }
  /** No such key (or no authorized_keys at all) */
  | undefined;

const KEY_TYPE = /^(ssh-|ecdsa-sha2-)/;

/** Nobody but `uid` or the admin can change this node */
function onlyOwnerWrites(node: Node, uid: UserId): boolean {
  const { props } = node;
  if (props.uid !== uid && props.uid !== ADMIN_UID) return false;
  if ((props.mode & 0o022) !== 0) return false;
  for (const entry of props.acl ?? []) {
    if (entry.uid === uid) continue;
    if (checkMode(entry.mode, 'w', MaskACL)) return false;
  }
  return true;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/**
 * The authorized key matching `keyData` (the public key blob the client
 * offered), or why this user's keys are not honoured.
 */
export async function findAuthorizedKey(
  vfs: NodeVFS,
  homePath: string,
  uid: UserId,
  keyData: Uint8Array,
): Promise<AuthorizedKeyResult> {
  const dotSsh = `${homePath}/.ssh`;
  const file = `${dotSsh}/authorized_keys`;

  const get = (path: string) => vfs.get(ADMIN_ACCESS, path, { follow: false }).catch(() => undefined);
  const [home, dir, keys] = await Promise.all([get(homePath), get(dotSsh), get(file)]);
  if (!home || !dir || !keys) return undefined;

  if (dir.type !== NODE_TYPE_DIRECTORY || keys.type !== NODE_TYPE_FILE) {
    return { refused: `${file}: not a plain directory and file` };
  }
  for (const [path, node] of [[homePath, home], [dotSsh, dir], [file, keys]] as const) {
    if (!onlyOwnerWrites(node, uid)) return { refused: `bad ownership or modes for ${path}` };
  }

  const handle = await vfs.open(ADMIN_ACCESS, file, { mode: 'r' });
  let text: string;
  try {
    text = await toText(handle.readable);
  } finally {
    await handle.close();
  }

  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || !KEY_TYPE.test(line)) continue;

    const parsed = parseKey(line);
    if (parsed instanceof Error) continue;
    const key = Array.isArray(parsed) ? parsed[0] : parsed;
    const blob = key.getPublicSSH();
    if (blob && sameBytes(blob, keyData)) return { key };
  }
  return undefined;
}
