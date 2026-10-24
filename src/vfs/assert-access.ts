import { Access, AccessLevel, isAdmin, verifyAccess } from '../lib/access/mod.ts';
import type { GroupId, Ownership, UserId } from '../lib/mode/mod.ts';
import { NodeAccessDeniedError, NodeInvalidOperationError } from './errors.ts';
import type { NodeAttrs, NodeId, NodeType } from './node.ts';
import type { NodeAttrsUpdate, NodePropsUpdate } from './types.ts';
import { UNLISTED_ATTR } from './types/directory.ts';
import { NODE_TYPE_GROUP } from './types/group.ts';
import { NODE_TYPE_SESSION } from './types/session.ts';
import { NODE_TYPE_USER } from './types/user.ts';

/**
 * @description Assert that access has the required level for the node.
 */
export const assertAccess = (
  access: Access,
  node: { id: NodeId; props: Ownership },
  level: AccessLevel,
) => {
  if (!verifyAccess(access, node.props, level)) {
    throw new NodeAccessDeniedError(node.id, level);
  }
};

/**
 * Assert that `access` may give a node the owner and group in `props`. `current` is what the node
 * carries without them: its present owner and group, or, for a new node, its creator and its
 * parent's group.
 *
 * As on Linux, only the administrator gives a node to another user, and anyone else may move it
 * only into a group they are in: otherwise a user could make what they wrote read as someone
 * else's, or file it in a group they are not in. A configured default owner is applied by the
 * server, not under this rule (`share-set --default-owner`).
 */
export const assertOwnershipAllowed = (
  access: Access,
  node: string,
  current: { uid: UserId; gid: GroupId },
  props?: { uid?: UserId; gid?: GroupId },
) => {
  if (!props || isAdmin(access)) return;
  if (props.uid !== undefined && props.uid !== current.uid) {
    throw new NodeAccessDeniedError(node, 'change uid');
  }
  if (props.gid !== undefined && props.gid !== current.gid && props.gid !== access.gid && !access.gids.includes(props.gid)) {
    throw new NodeAccessDeniedError(node, 'change gid');
  }
};

/** The node types whose attrs become who someone is: an account, a group, a signed-in session. */
const IDENTITY_TYPES: ReadonlySet<NodeType> = new Set([NODE_TYPE_USER, NODE_TYPE_GROUP, NODE_TYPE_SESSION]);

/**
 * Assert that `access` may create a node of `type` at `path`, or (`link`) hard-link one there: a
 * user, a group or a session only an administrator makes, since the uid, gid or access it is
 * created with is who it is — wherever it is made, as a command may be pointed at another
 * directory of accounts. Copying one is creating one, and a hard link would give the same account
 * a second name.
 */
export const assertIdentityCreatable = (access: Access, path: string, type: NodeType, verb: 'create' | 'link' = 'create') => {
  if (IDENTITY_TYPES.has(type) && !isAdmin(access)) {
    throw new NodeAccessDeniedError(path, `${verb} ${type}`);
  }
};

/**
 * An account's number: a user's uid, a group's gid. Ownership, ACL entries and sessions name it,
 * never the node, so it is fixed when the account is created — a new number would leave everything
 * that names the old one to nobody, or to whichever account takes the number next.
 */
const ACCOUNT_IDS: Partial<Record<NodeType, string>> = {
  [NODE_TYPE_USER]: 'uid',
  [NODE_TYPE_GROUP]: 'gid',
};

/**
 * The attrs that decide as whom a session acts: its access and the secret its cookie must match.
 * With the node's owner and group they are the administrator's. An account needs no such list: it
 * is the administrator's node, which its user cannot write at all.
 */
const ACCOUNT_ATTRS: Partial<Record<NodeType, readonly string[]>> = {
  [NODE_TYPE_SESSION]: ['access', 'secret'],
};

const changes = (attrs: NodeAttrsUpdate | undefined, node: { attrs: NodeAttrs }, key: string): boolean =>
  attrs !== undefined && key in attrs && (attrs[key] ?? undefined) !== (node.attrs[key] ?? undefined);

/**
 * Assert that an update leaves an identity alone: an account's or group's number for everyone,
 * and, unless an administrator makes it, a session's access and secret and the owner and group of
 * any of them — write access to a session is not enough to change whom it acts as.
 */
export const assertIdentityUnchanged = (
  access: Access,
  node: { id: NodeId; type: NodeType; props: Ownership; attrs: NodeAttrs },
  props?: NodePropsUpdate,
  attrs?: NodeAttrsUpdate,
) => {
  if (!IDENTITY_TYPES.has(node.type)) return;
  const id = ACCOUNT_IDS[node.type];
  if (id && changes(attrs, node, id)) {
    throw new NodeInvalidOperationError(`${node.type === NODE_TYPE_USER ? "a user's uid" : "a group's gid"} is set when it is created and cannot be changed: ${node.id}`);
  }
  if (isAdmin(access)) return;
  for (const key of ACCOUNT_ATTRS[node.type] ?? []) {
    if (changes(attrs, node, key)) throw new NodeAccessDeniedError(node.id, `change ${key}`);
  }
  for (const key of ['uid', 'gid'] as const) {
    if (props?.[key] !== undefined && props[key] !== node.props[key]) {
      throw new NodeAccessDeniedError(node.id, `change ${key}`);
    }
  }
};

/**
 * Attrs whose effect reaches past the node to what everyone else sees, so write access is not
 * enough to change them: `unlisted` takes a tree out of every user's library views.
 */
const OWNER_ATTRS: readonly string[] = [UNLISTED_ATTR];

/** Assert that an update changes none of the `OWNER_ATTRS` unless the node's owner or an administrator makes it. */
export const assertOwnerAttrsUnchanged = (
  access: Access,
  node: { id: NodeId; props: Ownership; attrs: NodeAttrs },
  attrs?: NodeAttrsUpdate,
) => {
  if (isAdmin(access) || access.uid === node.props.uid) return;
  for (const key of OWNER_ATTRS) {
    if (changes(attrs, node, key)) throw new NodeAccessDeniedError(node.id, `change ${key}`);
  }
};
