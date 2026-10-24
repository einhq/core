import { QueueResourceOptions } from '../../registries/queue/mod.ts';
import type { NodeAttrs, NodeType } from '../node.ts';

/**
 * QueueAttrs - Attributes for queue nodes
 *
 * Queue nodes are persistent FIFO buffers connected to a stream.
 * Reads are destructive (entry removed from queue on read).
 */
export type QueueAttrs = NodeAttrs & QueueResourceOptions;

export const NODE_TYPE_QUEUE: NodeType = 'queue';
