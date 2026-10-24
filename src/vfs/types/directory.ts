import { NodeAttrs, NodeType } from '../node.ts';

export type DirectoryAttrs = NodeAttrs;

export const NODE_TYPE_DIRECTORY: NodeType = 'directory';

/**
 * The attr that marks a directory unlisted, with `true`: what it holds is left out of the views of
 * the whole library. Only the directory's owner or an administrator sets or clears it.
 */
export const UNLISTED_ATTR = 'unlisted';
