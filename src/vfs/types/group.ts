import { GroupId } from '../../lib/mode/mod.ts';
import { Node, NodeAttrs, NodeType } from '../node.ts';

export type GroupAttrs = NodeAttrs & {
  gid: GroupId;
  title?: string;
  description?: string;
};

export const NODE_TYPE_GROUP: NodeType = 'group';

/**
 * Whether a node is a group: a `group` node with a numeric gid. Membership at sign-in and the
 * commands that list groups count these alone, so another node under the groups directory with a
 * `gid` attr makes nobody a member.
 */
export const isGroupNode = (node: Node): node is Node<GroupAttrs> => node.type === NODE_TYPE_GROUP && typeof node.attrs.gid === 'number';
