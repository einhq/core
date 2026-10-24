/**
 * Position node type: a point on the map with an optional shape, a radius
 * (circle) or a polygon ring. What has a position keeps it as a child named
 * `position`; the shape is content, stored by the PositionRegistry (PostGIS),
 * and the node has no attrs of its own.
 */

import type { NodeType } from '../node.ts';

export const NODE_TYPE_POSITION: NodeType = 'position';
