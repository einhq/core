import { RegistryIf, ResourceOptions } from '../types.ts';

export type EmbeddingResourceOptions = ResourceOptions & {
  embeddingType: string;
  capacity: number;
};

export type EmbeddingStat = {
  size: number;
  vectorSize: number;
  embeddingType: string;
};

/** Async get/set IO pair used by handles backed by external storage. */
export interface EmbeddingAsyncIO {
  get: () => Promise<Uint8Array>;
  set: (data: Uint8Array) => Promise<void>;
}

/** Result of a similarity search, pairing an embedding id with its cosine similarity score. */
export type SimilarityMatch = {
  /** The id of the matched embedding. */
  id: string;
  /** Cosine similarity score between 0 and 1, where 1 is identical. */
  similarity: number;
};

/** An edge between two similar embeddings, from an all-pairs search. */
export type SimilarPair = {
  /** The id of the source embedding. */
  a: string;
  /** The id of a near neighbour of `a`. */
  b: string;
  /** Cosine similarity between 0 and 1, where 1 is identical. */
  similarity: number;
};

/** Registry interface for storing and querying vector embeddings. */
export interface EmbeddingRegistryIf extends RegistryIf<EmbeddingResourceOptions, EmbeddingStat> {
  /**
   * Find embeddings similar to the given vector using cosine similarity.
   * Returns up to `limit` matches with similarity >= `threshold`, ordered by closeness.
   *
   * With `within`, only those ids are ranked, and exactly: the question "which of *these*
   * pictures shows a sailboat" — one person's, one album's — that a nearest-neighbour search
   * over the whole type cannot answer, since its best few hundred rows need not include any of
   * them. Ids with no vector of this type are simply not matched.
   */
  findSimilar(embeddingType: string, data: Uint8Array, limit?: number, threshold?: number, within?: string[]): Promise<SimilarityMatch[]>;

  /**
   * All near-neighbour edges among the embeddings of one type, in a single
   * query — each embedding's up-to-`limit` nearest neighbours with similarity
   * >= `threshold`. Every edge appears in both directions. Used to cluster a
   * whole set (e.g. duplicate detection) without a findSimilar call per row.
   */
  findAllPairs(embeddingType: string, limit?: number, threshold?: number): Promise<SimilarPair[]>;

  /**
   * The raw vectors for a set of ids, in one round trip.
   *
   * findSimilar and findAllPairs answer "who is near whom" across a whole type;
   * this answers "give me exactly these N vectors", so a caller can do its own
   * pairwise work over a subset it has already chosen — sub-clustering one
   * person's faces, say, where the interesting comparisons are all inside a set
   * the index cannot express. The alternative is one handle read per id.
   *
   * Ids with no stored vector are simply absent from the map.
   */
  getVectors(embeddingType: string, ids: string[]): Promise<Map<string, Uint8Array>>;
}
