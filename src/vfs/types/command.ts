import { type CmdSpec } from '../../managers/exec/mod.ts';
import { NodeAttrs, NodeType } from '../node.ts';

export type CommandAttrs = NodeAttrs & CmdSpec;

export const NODE_TYPE_COMMAND: NodeType = 'command';
