import type { NodeOwnership } from '@ein/api';
export type { NodeOwnership } from '@ein/api';

export type AccessIds = {
  uid: number;
  gids: number[];
  /** Explicit privilege carried by the authenticated session. */
  admin?: boolean;
};

/** A node's mode, owner and group, and the access list a listing carries with them. */
export type NodeAccessProps = NodeOwnership & { acl?: { mode: number; uid?: number; gid?: number }[] };

export type AccessBit = 'r' | 'w' | 'x';

const ADMIN_UID = 0;
const GUEST_UID = 1001;
const SHIFT: Record<AccessBit, number> = { r: 2, w: 1, x: 0 };

/** Whether the reader is the guest: someone who has not signed in, where the archive is open to them. */
export const isGuest = (access: AccessIds | null): boolean => access?.uid === GUEST_UID;

/**
 * Whether the reader holds one permission on a node, decided as the server's
 * `verifyAccess` decides it: owner, group and other bits, then the access
 * list, whose entries carry their bits where other's are, and never write
 * for the guest. Only a guide for
 * what to offer — the server still checks every call.
 */
export function canAccess(node: NodeAccessProps, access: AccessIds | null, bit: AccessBit): boolean {
  if (!access) return false;
  if (access.admin === true || access.uid === ADMIN_UID) return true;
  if (bit === 'w' && isGuest(access)) return false;
  const shift = SHIFT[bit];
  if (access.uid === node.uid && (node.mode & (1 << (shift + 6))) !== 0) return true;
  if (access.gids.includes(node.gid) && (node.mode & (1 << (shift + 3))) !== 0) return true;
  if ((node.mode & (1 << shift)) !== 0) return true;
  return (node.acl ?? []).some((entry) =>
    ((entry.uid !== undefined && entry.uid === access.uid) || (entry.gid !== undefined && access.gids.includes(entry.gid))) &&
    (entry.mode & (1 << shift)) !== 0
  );
}

export function canWrite(node: NodeAccessProps, access: AccessIds | null): boolean {
  return canAccess(node, access, 'w');
}

/**
 * Whether the reader may change every one of `items`. One whose ownership its list did not carry
 * counts as yes, except for the guest, who writes nothing: this only decides what to offer, and
 * the server checks each anyway.
 */
export function canWriteEach(items: readonly { ownership?: NodeAccessProps }[], access: AccessIds | null): boolean {
  return items.every((item) => item.ownership ? canWrite(item.ownership, access) : !isGuest(access));
}

/**
 * Whether the reader may list a node's children: the server asks for read and
 * execute on the node itself. While the reader is not yet known the answer is
 * yes, so nothing is locked for the moment the identity takes to arrive.
 */
export function canList(node: NodeAccessProps, access: AccessIds | null): boolean {
  if (!access) return true;
  return canAccess(node, access, 'r') && canAccess(node, access, 'x');
}

const DENIED: Record<string, string> = {
  r: 'You do not have permission to read this.',
  w: 'You do not have permission to change this.',
  x: 'You do not have permission to open this.',
};

/**
 * A node command's failure in words: the VFS's access and not-found errors,
 * which name a node by its id, said plainly; anything else as its first line,
 * without the `command: ` a terminal wants in front of it.
 */
export function describeNodeError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const denied = /Access denied for operation '(\w)'/.exec(raw);
  if (denied) return DENIED[denied[1]] ?? 'You do not have permission to do that.';
  if (isNotFound(raw)) return 'There is nothing at this path.';
  const line = raw.split('\n').find((each) => each.trim()) ?? raw;
  return line.replace(/^[\w-]+:\s+/, '').trim();
}

/** Whether a failure is the VFS refusing access, which is told apart from a fault. */
export const isAccessDenied = (err: unknown): boolean => /Access denied for operation/.test(err instanceof Error ? err.message : String(err));

/** Whether a failure is the VFS finding nothing at the path. */
export const isNotFound = (err: unknown): boolean => /Node not found/.test(err instanceof Error ? err.message : String(err));
