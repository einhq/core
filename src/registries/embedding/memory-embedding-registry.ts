/**
 * MemoryEmbeddingRegistry - In-memory embedding storage with naive cosine
 * similarity search. Mirrors the PostgreSQL/pgvector registry semantics:
 * vectors are stored as text ("[0.1,0.2,...]") encoded as bytes.
 */

import { ensureResource, ResourceMode } from '../types.ts';
import { EmbeddingHandle } from './embedding-handle.ts';
import { EmbeddingAsyncIO, EmbeddingRegistryIf, EmbeddingResourceOptions, EmbeddingStat, SimilarityMatch, SimilarPair } from './types.ts';

type MemoryEmbeddingEntry = {
  embeddingType: string;
  capacity: number;
  data: Uint8Array;
};

function parseVector(data: Uint8Array): number[] {
  const text = new TextDecoder().decode(data);

  if (!text.startsWith('[')) {
    throw new Error(`invalid embedding format, must start with [`);
  }

  if (!text.endsWith(']')) {
    throw new Error(`invalid embedding format, must end with ]`);
  }

  return JSON.parse(text);
}

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) {
    throw new Error(`vector dimensions do not match: ${a.length} vs ${b.length}`);
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) return 0;

  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export class MemoryEmbeddingRegistry implements EmbeddingRegistryIf {
  private entries = new Map<string, MemoryEmbeddingEntry>();

  async init(): Promise<void> {}

  async dispose(): Promise<void> {
    this.entries.clear();
  }

  /** Create an embedding entry if it does not already exist. Returns true if created. */
  async touch(id: string, opts: EmbeddingResourceOptions): Promise<boolean> {
    if (this.entries.has(id)) {
      return false;
    }

    this.entries.set(id, {
      embeddingType: opts.embeddingType,
      capacity: opts.capacity,
      data: new Uint8Array(0),
    });

    return true;
  }

  /** Open an embedding by id, returning a handle for reading or writing vector data. */
  async open(id: string, opts: EmbeddingResourceOptions, mode?: ResourceMode): Promise<EmbeddingHandle> {
    await ensureResource(this, id, opts, mode);

    const io: EmbeddingAsyncIO = {
      get: async () => this.entries.get(id)?.data ?? new Uint8Array(0),
      set: async (data: Uint8Array) => {
        const entry = this.entries.get(id);
        if (!entry) {
          throw new Error(`no embedding found: ${id}`);
        }

        if (data.length > 0) {
          parseVector(data); // validate format
        }

        entry.data = data;
      },
    };

    const rh = new EmbeddingHandle(id, opts, mode || 'r', this, io);
    await rh.init();

    return rh;
  }

  async exists(id: string): Promise<boolean> {
    return this.entries.has(id);
  }

  /** Return metadata (type, vector size, byte size) for an embedding. Throws if not found. */
  async stat(id: string): Promise<EmbeddingStat> {
    const entry = this.entries.get(id);

    if (!entry) {
      throw new Error(`no embedding found: ${id}`);
    }

    return {
      size: entry.data.length,
      vectorSize: entry.capacity,
      embeddingType: entry.embeddingType,
    };
  }

  async statX(id: string): Promise<EmbeddingStat> {
    return this.stat(id);
  }

  async delete(id: string): Promise<boolean> {
    return this.entries.delete(id);
  }

  async list(): Promise<AsyncIterable<string>> {
    const ids = [...this.entries.keys()];

    return (async function* () {
      for (const id of ids) {
        yield id;
      }
    })();
  }

  async count(_id?: string): Promise<number> {
    return this.entries.size;
  }

  /**
   * Find embeddings similar to the given vector using cosine similarity.
   * Returns up to `limit` matches with similarity >= `threshold`, ordered by closeness.
   */
  async findSimilar(embeddingType: string, data: Uint8Array, limit = 10, threshold = 0.6, within?: string[]): Promise<SimilarityMatch[]> {
    const query = parseVector(data);
    const matches: SimilarityMatch[] = [];
    const only = within ? new Set(within) : undefined;

    for (const [id, entry] of this.entries) {
      if (entry.embeddingType !== embeddingType || entry.data.length === 0 || (only && !only.has(id))) {
        continue;
      }

      const similarity = cosineSimilarity(query, parseVector(entry.data));

      if (similarity >= threshold) {
        matches.push({ id, similarity });
      }
    }

    matches.sort((a, b) => b.similarity - a.similarity);

    return matches.slice(0, limit);
  }

  async findAllPairs(embeddingType: string, limit = 10, threshold = 0.6): Promise<SimilarPair[]> {
    const items = [...this.entries]
      .filter(([, entry]) => entry.embeddingType === embeddingType && entry.data.length > 0)
      .map(([id, entry]) => ({ id, vec: parseVector(entry.data) }));

    const pairs: SimilarPair[] = [];
    for (const a of items) {
      const near = items
        .filter((b) => b.id !== a.id)
        .map((b) => ({ id: b.id, similarity: cosineSimilarity(a.vec, b.vec) }))
        .filter((m) => m.similarity >= threshold)
        .sort((x, y) => y.similarity - x.similarity)
        .slice(0, limit);
      for (const n of near) pairs.push({ a: a.id, b: n.id, similarity: n.similarity });
    }
    return pairs;
  }

  async getVectors(embeddingType: string, ids: string[]): Promise<Map<string, Uint8Array>> {
    const out = new Map<string, Uint8Array>();

    for (const id of ids) {
      const entry = this.entries.get(id);
      if (!entry || entry.embeddingType !== embeddingType || entry.data.length === 0) continue;
      out.set(id, entry.data);
    }

    return out;
  }
}
