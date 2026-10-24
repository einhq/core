# Blob Registry

Binary storage with two backends: PostgreSQL large objects and in-memory.

## Backends

### PgBlobRegistry

Stores content as PostgreSQL large objects. A mapping table tracks node_id to OID associations.

An open handle keeps the object's OID and its own position, not a descriptor. Each operation is one statement in its own transaction (`lo_get`, `lo_put`, or an `lo_open` the statement's end closes), so a handle holds no connection between calls and every write is committed when it returns (ein/core#308).

- `stat()` returns size via `lo_lseek64`
- `statX()` streams the LOB to compute SHA-256 hash and detect MIME type
- `delete()` calls `lo_unlink` to remove the large object

### MemoryBlobRegistry

Stores blobs in a `Map<string, Uint8Array>`. Useful for testing.

- Does not track creation/modification times
- `statX()` computes SHA-256 and MIME from the in-memory buffer

## Usage

```typescript
const registry = new PgBlobRegistry({ pool, prefix: 'myapp' });
await registry.init(); // creates mapping table

// Write a blob
const w = await registry.open('abc123', {}, 'w');
await w.write(new TextEncoder().encode('content'));
await w.close();

// Read it back
const r = await registry.open('abc123', {}, 'r');
const data = await r.read(4096);
await r.close();

// Extended stats
const info = await registry.statX('abc123');
// { size, mimetype, sha256 }
```

## Configuration

### PgBlobRegistry

| Option   | Type   | Description                                       |
| -------- | ------ | ------------------------------------------------- |
| `pool`   | Pool   | PostgreSQL connection pool                        |
| `prefix` | string | Table name prefix (e.g. `myapp` -> `myapp_blobs`) |
