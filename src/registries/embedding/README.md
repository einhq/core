# Embedding Registry

Manages typed vector embeddings in PostgreSQL with the pgvector extension. Supports multiple embedding types (face, image, text, etc.) with different vector dimensions.

## Backend

PostgreSQL + pgvector. Each embedding type gets a dedicated table with an HNSW index for fast approximate nearest neighbor search.

## Core Concepts

- **Embedding types**: Registered lazily via `touch()`. Each type has a fixed vector dimension.
- **HNSW index**: Created per type with `m=16, ef_construction=64`. Queries use an `ef_search` of at least 64, raised to the requested result limit (pgvector caps it at 1000). `findSimilar` runs an iterative scan (`hnsw.iterative_scan = strict_order`), so a limit above 1000 is still returned in full and in exact distance order; `hnsw.max_scan_tuples` is raised to twice the limit so the walk does not stop at pgvector's default of 20 000.
- **Cosine similarity**: `findSimilar()` returns matches ordered by cosine distance.
- **Vector format**: Stored as JSON arrays `[0.1, 0.2, ...]` encoded as UTF-8 bytes.
- **Storage**: a new type's column is `halfvec` (float16). HNSW indexes `halfvec` up to 4000 dimensions (against 2000 for `vector`) at half the size, and float16 moves a cosine distance only around the fourth decimal. A table created as `vector` keeps its column: the registry reads each table's column type from the catalogue and casts and indexes with that.

## SQL Schema

```sql
-- Metadata table (one per registry)
CREATE TABLE {name}_embeddings (
  id         VARCHAR(26) PRIMARY KEY,
  type       TEXT NOT NULL,
  size       INT NOT NULL,        -- vector dimension
  size_bytes INT NOT NULL,        -- byte size of stored vector
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Per-type vector table
CREATE TABLE {name}_embeddings_{type}_data (
  id        VARCHAR(26) PRIMARY KEY REFERENCES {name}_embeddings ON DELETE CASCADE,
  embedding halfvec({size}) NOT NULL,   -- or vector({size}) on a table created as vector
  created_at TIMESTAMPTZ DEFAULT now()
);
-- + HNSW index on embedding column (halfvec_cosine_ops / vector_cosine_ops)
```

## Usage

```typescript
const registry = new EmbeddingRegistry({ pool: pgPool, name: 'app' });
await registry.init();

// Store an embedding
await registry.touch('node-1', { type: 'face', size: 512 });
const handle = await registry.open('node-1', { type: 'face', size: 512 }, 'w');
const vector = new TextEncoder().encode(JSON.stringify([0.1, 0.2 /* ... */]));
await handle.write(vector);
await handle.close();

// Similarity search
const matches = await registry.findSimilar('face', vector, 10, 0.6);
// [{ id: "node-5", similarity: 0.92 }, ...]
```

## Configuration

| Option | Type    | Description                |
| ------ | ------- | -------------------------- |
| `pool` | pg.Pool | PostgreSQL connection pool |
| `name` | string  | Prefix for table names     |
