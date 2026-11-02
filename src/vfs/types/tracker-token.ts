import type { UserId } from '../../lib/mode/mod.ts';
import { Node, NodeAttrs, NodeType } from '../node.ts';

/**
 * A track's tracker token: the secret in the URL a phone or GPS tracker posts its fixes to. Kept
 * as the track's child `.tracker`, mode 0600 and the administrator's, so only `track-token` reads
 * it, for whoever may change the track.
 */
export type TrackerTokenAttrs = NodeAttrs & {
  token: string;
  createdBy: UserId;
  createdAt: number;
};

export const NODE_TYPE_TRACKER_TOKEN: NodeType = 'tracker-token';

/** Whether a node is a tracker token: a `tracker-token` node with its token. */
export const isTrackerTokenNode = (node: Node): node is Node<TrackerTokenAttrs> => node.type === NODE_TYPE_TRACKER_TOKEN && typeof node.attrs.token === 'string';
