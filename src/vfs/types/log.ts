import { LogResourceOptions } from '../../registries/log/mod.ts';
import type { NodeAttrs, NodeType } from '../node.ts';

/**
 * LogAttrs - Attributes for log nodes
 */
export type LogAttrs = NodeAttrs & LogResourceOptions;

export const NODE_TYPE_LOG: NodeType = 'log';
