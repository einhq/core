# File Registry

Binary file storage with two backends: filesystem and in-memory.

## Backends

### DiskFileRegistry

Stores files on the local filesystem using bucketed storage:

```
{rootPath}/{id[-2:]}/{id}
```

IDs starting with `/` are treated as absolute paths relative to the root.

- `stat()` returns size, timestamps, permissions, and absolute path
- `statX()` additionally computes SHA-256 hash and detects MIME type
- Empty bucket directories are cleaned up on delete

### MemoryFileRegistry

Stores files in a `Map<string, Uint8Array>`. Useful for testing.

- Does not track creation/modification times
- `statX()` computes SHA-256 and MIME from the in-memory buffer

## Usage

```typescript
const registry = new DiskFileRegistry({ rootPath: './files' });
await registry.init(); // creates root directory

// Write a file
const w = await registry.open('abc123', {}, 'w');
await w.write(new TextEncoder().encode('content'));
await w.close();

// Read it back
const r = await registry.open('abc123', {}, 'r');
const data = await r.read(4096);
await r.close();

// Extended stats
const info = await registry.statX('abc123');
// { size, mtime, birthtime, path, mimetype, sha256 }
```

## Configuration

### DiskFileRegistry

| Option     | Type   | Description                     |
| ---------- | ------ | ------------------------------- |
| `rootPath` | string | Base directory for file storage |
