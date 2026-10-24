/** One embedding near the one `find-similar` was asked about. */
export type SimilarHit = {
  /** The matched embedding's node id. */
  id: string;
  /** Cosine similarity, 1 for identical. */
  similarity: number;
  /** Where the embedding node is linked; usually one path. */
  paths: string[];
};

/** `find-similar`: the embeddings of the same type nearest to one, nearest first. */
export type SimilarAnswer = { hits: SimilarHit[] };
