/**
 * Embedding node type - Stores vector embeddings for similarity search
 *
 * Generic embedding type supporting face, image, text, video, etc.
 * Each node's embeddingType + capacity attrs determine the vector type and dimension.
 * The vector is content, stored by the embedding registry.
 */

import { EmbeddingResourceOptions } from '../../registries/embedding/mod.ts';
import type { NodeAttrs, NodeType } from '../node.ts';

/**
 * Embedding node attributes
 */
export type EmbeddingAttrs = NodeAttrs & EmbeddingResourceOptions;

export const NODE_TYPE_EMBEDDING: NodeType = 'embedding';
