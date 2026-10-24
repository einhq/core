/**
 * EmbeddingRegistry - Manages typed embeddings in PostgreSQL with pgvector
 *
 * Supports multiple embedding types (face, image, text, etc.) with different
 * vector dimensions. Each type gets its own table. Types are registered lazily
 * via registerType() which is idempotent.
 */

import type { Pool } from 'pg';
import { ensureResource, ResourceMode } from '../types.ts';
import { EmbeddingHandle } from './embedding-handle.ts';
import { EmbeddingAsyncIO, EmbeddingRegistryIf, EmbeddingResourceOptions, EmbeddingStat, SimilarityMatch, SimilarPair } from './types.ts';

/** What the PostgreSQL-backed registry needs. Here rather than in `types.ts`, which is a contract type file and must not reach `pg`. */
type EmbeddingRegistryConfig = {
  pool: Pool;
  name: string;
};

const MIN_HNSW_EF_SEARCH = 64;
/** pgvector accepts `hnsw.ef_search` values up to 1000. */
const MAX_HNSW_EF_SEARCH = 1000;
/** pgvector's default `hnsw.max_scan_tuples`: how many tuples an iterative scan visits before it gives up. */
const MIN_HNSW_MAX_SCAN_TUPLES = 20_000;

/**
 * How a type's vectors are stored. New types are `halfvec` (float16): pgvector's HNSW indexes
 * `halfvec` up to 4000 dimensions against 2000 for `vector`, at half the size, and float16 moves
 * a cosine distance only around the fourth decimal. A table created as `vector` keeps its column;
 * the registry reads which one a table has rather than assuming.
 */
type Storage = 'vector' | 'halfvec';
const NEW_TYPE_STORAGE: Storage = 'halfvec';

export class EmbeddingRegistry implements EmbeddingRegistryIf {
  private tablePrefix: string;
  private pool: Pool;
  private types = new Set<string>();
  private registering = new Map<string, Promise<void>>();
  private storage = new Map<string, Storage>();
  private initialized = false;

  constructor(private config: EmbeddingRegistryConfig) {
    const name = `${config.name}_embeddings`;
    if (!/^[a-z_][a-z0-9_]*$/i.test(name)) {
      throw new Error(`invalid table prefix: ${name}`);
    }
    this.tablePrefix = name;
    this.pool = config.pool;
  }

  /** Initialize the registry by enabling pgvector and creating the embeddings metadata table. */
  async init(): Promise<void> {
    if (this.initialized) {
      return;
    }

    const client = await this.pool.connect();
    try {
      await client.query(`CREATE EXTENSION IF NOT EXISTS vector;`);

      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.embeddingsTable} (
          id            VARCHAR(26) PRIMARY KEY,
          type          TEXT NOT NULL,
          size          INT NOT NULL,
          size_bytes    INT NOT NULL,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);
    } finally {
      client.release();
    }

    this.initialized = true;
  }

  /** Release any resources held by the registry. */
  async dispose(): Promise<void> {}

  /** Create an embedding entry if it does not already exist. Returns true if created. */
  async touch(id: string, opts: EmbeddingResourceOptions): Promise<boolean> {
    const { embeddingType, capacity } = opts;

    await this.registerType(embeddingType, capacity);

    const client = await this.pool.connect();

    try {
      const res = await client.query(
        `
        INSERT INTO ${this.embeddingsTable} (id, type, size, size_bytes)
        VALUES ($1, $2, $3, 0)
        ON CONFLICT (id) DO NOTHING
        `,
        [id, embeddingType, capacity],
      );

      return res.rowCount === 1;
    } finally {
      client.release();
    }
  }

  /** Open an embedding by id, returning a handle for reading or writing vector data. */
  async open(id: string, opts: EmbeddingResourceOptions, mode?: ResourceMode): Promise<EmbeddingHandle> {
    await ensureResource(this, id, opts, mode);

    const { embeddingType } = opts;

    const io: EmbeddingAsyncIO = {
      get: async () => await this.vectorGet(id, embeddingType),
      set: async (data: Uint8Array) => this.vectorSet(id, embeddingType, data),
    };

    const rh = new EmbeddingHandle(id, opts, mode || 'r', this, io);
    await rh.init();

    return rh;
  }

  /** Check whether an embedding with the given id exists. */
  async exists(id: string): Promise<boolean> {
    const client = await this.pool.connect();

    try {
      const result = await client.query<{ exists: boolean }>(
        `
        SELECT EXISTS (
          SELECT 1 FROM ${this.embeddingsTable} WHERE id = $1
        ) AS exists
        `,
        [id],
      );

      return result.rows[0]?.exists ?? false;
    } finally {
      client.release();
    }
  }

  /** Return metadata (type, vector size, byte size) for an embedding. Throws if not found. */
  async stat(id: string): Promise<EmbeddingStat> {
    const client = await this.pool.connect();

    try {
      const result = await client.query<{ type: string; size: number; size_bytes: number }>(
        `SELECT * FROM ${this.embeddingsTable} WHERE id = $1`,
        [id],
      );

      if (result.rows.length === 0) {
        throw new Error(`no embedding found: ${id}`);
      }

      return {
        size: result.rows[0].size_bytes,
        vectorSize: result.rows[0].size,
        embeddingType: result.rows[0].type,
      };
    } finally {
      client.release();
    }
  }

  /** Same as stat() -- extended stat with no additional fields for embeddings. */
  async statX(id: string): Promise<EmbeddingStat> {
    return this.stat(id);
  }

  /** Delete an embedding by id. Returns true if a row was removed. */
  async delete(id: string): Promise<boolean> {
    const client = await this.pool.connect();

    try {
      const result = await client.query(
        `DELETE FROM ${this.embeddingsTable} WHERE id = $1`,
        [id],
      );

      return (result.rowCount ?? 0) > 0;
    } finally {
      client.release();
    }
  }

  /** Return an async iterable of all embedding ids in the registry. */
  async list(): Promise<AsyncIterable<string>> {
    const client = await this.pool.connect();

    try {
      const result = await client.query<{ id: string }>(
        `SELECT id FROM ${this.embeddingsTable}`,
      );

      return (async function* () {
        for (const row of result.rows) {
          yield row.id;
        }
      })();
    } finally {
      client.release();
    }
  }

  /** Return the total number of embeddings in the registry. */
  async count(_id?: string): Promise<number> {
    const client = await this.pool.connect();

    try {
      const result = await client.query<{ count: string }>(
        `SELECT COUNT(*) AS count FROM ${this.embeddingsTable}`,
      );

      return Number(result.rows[0]?.count ?? '0');
    } finally {
      client.release();
    }
  }

  /**
   * Find embeddings similar to the given vector using cosine similarity.
   * Returns up to `limit` matches with similarity >= `threshold`, ordered by closeness.
   */
  async findSimilar(embeddingType: string, data: Uint8Array, limit = 10, threshold = 0.6, within?: string[]): Promise<SimilarityMatch[]> {
    const embedding = new TextDecoder().decode(data);
    const maxDistance = 1 - threshold;
    const vectorsTable = this.getVectorsTable(embeddingType);
    const storage = await this.storageOf(embeddingType);
    if (within) return await this.rankWithin(vectorsTable, storage, embedding, limit, maxDistance, within);
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      // A plain HNSW scan returns at most `ef_search` rows (capped at 1000),
      // whatever the LIMIT. An iterative scan resumes the graph walk when the
      // executor asks for more, so a wide limit is honoured in full;
      // `strict_order` keeps rows in exact distance order, which the LIMIT cut
      // and the threshold filter below rely on. The walk stops after
      // `max_scan_tuples` visited tuples (default 20 000, about as many rows),
      // so it is raised with the limit.
      const efSearch = Math.min(MAX_HNSW_EF_SEARCH, Math.max(MIN_HNSW_EF_SEARCH, Math.ceil(limit)));
      const maxScanTuples = Math.max(MIN_HNSW_MAX_SCAN_TUPLES, Math.ceil(limit) * 2);
      await client.query(
        `SELECT set_config('hnsw.ef_search', $1, true), set_config('hnsw.iterative_scan', 'strict_order', true),
                set_config('hnsw.max_scan_tuples', $2, true)`,
        [String(efSearch), String(maxScanTuples)],
      );

      // The `ORDER BY embedding <=> $1 LIMIT` shape is what lets pgvector serve
      // this from the HNSW index. A `WHERE distance <= x` on the ordering
      // expression would defeat it (full scan), so the threshold is applied
      // after the index returns the nearest rows.
      const result = await client.query<{ id: string; dist: number }>(
        `
        SELECT id::text, embedding <=> $1::${storage} AS dist
        FROM ${vectorsTable}
        ORDER BY embedding <=> $1::${storage}
        LIMIT $2
        `,
        [embedding, limit],
      );

      await client.query('COMMIT');

      return result.rows
        .filter((row) => row.dist <= maxDistance)
        .map((row) => ({ id: row.id, similarity: 1 - row.dist }));
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  /**
   * `findSimilar` over a given set: a primary-key lookup and an exact distance per row, no
   * index scan — so no `hnsw.ef_search` ceiling, and every id in the set is considered. A
   * few thousand rows cost milliseconds.
   */
  private async rankWithin(vectorsTable: string, storage: Storage, embedding: string, limit: number, maxDistance: number, within: string[]): Promise<SimilarityMatch[]> {
    if (within.length === 0) return [];
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ id: string; dist: number }>(
        `
        SELECT id::text, dist FROM (
          SELECT id, embedding <=> $1::${storage} AS dist
          FROM ${vectorsTable}
          WHERE id = ANY($3::varchar[])
        ) ranked
        WHERE dist <= $4
        ORDER BY dist
        LIMIT $2
        `,
        [embedding, limit, [...new Set(within)], maxDistance],
      );
      return result.rows.map((row) => ({ id: row.id, similarity: 1 - row.dist }));
    } finally {
      client.release();
    }
  }

  async findAllPairs(embeddingType: string, limit = 10, threshold = 0.6): Promise<SimilarPair[]> {
    const maxDistance = 1 - threshold;
    const vectorsTable = this.getVectorsTable(embeddingType);
    const client = await this.pool.connect();

    try {
      await client.query('BEGIN');
      await client.query('SET LOCAL hnsw.ef_search = 64');

      // One LATERAL kNN per row, all in the DB. The inner
      // `ORDER BY a.embedding <=> b.embedding LIMIT` is HNSW-served (the query
      // vector is the correlated outer row), so this is N index lookups inside
      // Postgres rather than N round-trips, each computing distance to every row.
      const result = await client.query<{ a: string; b: string; similarity: number }>(
        `
        SELECT a.id::text AS a, nn.id::text AS b, 1 - nn.dist AS similarity
        FROM ${vectorsTable} a
        CROSS JOIN LATERAL (
          SELECT b.id, a.embedding <=> b.embedding AS dist
          FROM ${vectorsTable} b
          WHERE b.id <> a.id
          ORDER BY a.embedding <=> b.embedding
          LIMIT $1
        ) nn
        WHERE nn.dist <= $2
        `,
        [limit, maxDistance],
      );

      await client.query('COMMIT');

      return result.rows.map((row) => ({ a: row.a, b: row.b, similarity: row.similarity }));
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async getVectors(embeddingType: string, ids: string[]): Promise<Map<string, Uint8Array>> {
    const out = new Map<string, Uint8Array>();
    if (ids.length === 0) return out;

    const vectorsTable = this.getVectorsTable(embeddingType);
    const client = await this.pool.connect();

    try {
      // A primary-key lookup, not a search: no transaction and no hnsw.ef_search,
      // both of which only matter to the index scans above.
      const result = await client.query<{ id: string; embedding: string }>(
        `SELECT id::text AS id, embedding::text AS embedding FROM ${vectorsTable} WHERE id = ANY($1::varchar[])`,
        [ids],
      );

      const encoder = new TextEncoder();
      for (const row of result.rows) out.set(row.id, encoder.encode(row.embedding));
      return out;
    } finally {
      client.release();
    }
  }

  private sanitizeType(type: string): string {
    return type.replace(/[^a-z0-9_]/gi, '_');
  }

  private getVectorsTable(type: string): string {
    return `${this.tablePrefix}_${this.sanitizeType(type)}_data`;
  }

  private get embeddingsTable() {
    return `${this.tablePrefix}`;
  }

  /**
   * The column type a type's table has, or the one a new table gets. Read from the catalogue
   * once per process: a table made as `vector` keeps its column, and every
   * cast and index must name the same type the column is.
   */
  private async storageOf(type: string): Promise<Storage> {
    const known = this.storage.get(type);
    if (known) return known;
    const client = await this.pool.connect();
    try {
      const result = await client.query<{ kind: string }>(
        `SELECT t.typname AS kind
           FROM pg_attribute a JOIN pg_type t ON t.oid = a.atttypid
          WHERE a.attrelid = to_regclass($1) AND a.attname = 'embedding'`,
        [this.getVectorsTable(type)],
      );
      const kind = result.rows[0]?.kind;
      const storage: Storage = kind === 'vector' || kind === 'halfvec' ? kind : NEW_TYPE_STORAGE;
      // Only a table that exists is settled; a missing one is created by registerType as
      // NEW_TYPE_STORAGE, which is what is cached here too.
      this.storage.set(type, storage);
      return storage;
    } finally {
      client.release();
    }
  }

  /**
   * Create a type's vector table and index if they are missing. Concurrent calls for one type
   * share a single creation, and a transaction-scoped advisory lock on the table name serializes
   * it against other processes: two `CREATE TABLE IF NOT EXISTS` racing for one name fail on
   * the catalog's unique index instead of one of them skipping.
   */
  private registerType(type: string, size: number): Promise<void> {
    if (this.types.has(type)) {
      return Promise.resolve();
    }

    let pending = this.registering.get(type);
    if (!pending) {
      pending = this.createType(type, size).finally(() => this.registering.delete(type));
      this.registering.set(type, pending);
    }
    return pending;
  }

  private async createType(type: string, size: number): Promise<void> {
    const vectorsTable = this.getVectorsTable(type);
    const storage = await this.storageOf(type);
    const client = await this.config.pool.connect();

    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [vectorsTable]);

      await client.query(`
        CREATE TABLE IF NOT EXISTS ${vectorsTable} (
          id            VARCHAR(26) PRIMARY KEY REFERENCES ${this.embeddingsTable}(id) ON DELETE CASCADE,
          embedding     ${storage}(${size}) NOT NULL,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
        )
      `);

      await client.query(`
        CREATE INDEX IF NOT EXISTS ${vectorsTable}_hnsw_idx
        ON ${vectorsTable}
        USING hnsw (embedding ${storage}_cosine_ops)
        WITH (m = 16, ef_construction = 64)
      `);

      await client.query('COMMIT');
      this.types.add(type);
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async vectorSet(id: string, type: string, data: Uint8Array): Promise<void> {
    const storage = await this.storageOf(type);
    const client = await this.pool.connect();
    const vectorsTable = this.getVectorsTable(type);
    try {
      if (data.length === 0) {
        await client.query(
          `DELETE FROM ${vectorsTable} WHERE id = $1`,
          [id],
        );
      } else {
        const embedding = new TextDecoder().decode(data);

        if (!embedding.startsWith('[')) {
          throw new Error(`invalid embedding format, must start with [`);
        }

        if (!embedding.endsWith(']')) {
          throw new Error(`invalid embedding format, must end with ]`);
        }

        await client.query(
          `
          INSERT INTO ${vectorsTable} (id, embedding)
          VALUES ($1, $2::${storage})
          ON CONFLICT (id) DO UPDATE
            SET embedding = EXCLUDED.embedding
          `,
          [id, embedding],
        );
      }

      await client.query(
        `
        UPDATE ${this.embeddingsTable}
        SET size_bytes = $2
        WHERE id = $1
        `,
        [id, data.length],
      );
    } finally {
      client.release();
    }
  }

  private async vectorGet(id: string, type: string): Promise<Uint8Array> {
    const vectorsTable = this.getVectorsTable(type);
    const client = await this.pool.connect();

    try {
      const result = await client.query<{ embedding: string }>(
        `SELECT embedding::text FROM ${vectorsTable} WHERE id = $1`,
        [id],
      );

      if (result.rows.length === 0) {
        return new Uint8Array(0);
      }

      return new TextEncoder().encode(result.rows[0].embedding);
    } finally {
      client.release();
    }
  }
}
