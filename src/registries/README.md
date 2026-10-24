# Registries

Unified resource management layer. Each registry manages a collection of named resources identified by string IDs. All registries implement `RegistryIf` and all handles implement `ResourceHandleIf`.

## Architecture

```
RegistryIf (manages named resources)
  touch(id, opts)   -- create
  open(id, opts, mode) -- open handle
  exists(id)        -- check
  stat(id)          -- metadata
  delete(id)        -- remove
  list() / count()  -- enumerate

ResourceHandleIf (open resource)
  read(size, signal)  -- pull bytes
  write(data)         -- push bytes
  seek(offset, whence)
  readable / writable -- Web Streams
  close()
```

## Registries

| Registry                | Backend                  | Purpose                                       |
| ----------------------- | ------------------------ | --------------------------------------------- |
| [blob](blob/)           | PostgreSQL LOB / Memory  | Binary storage in PostgreSQL large objects    |
| [file](file/)           | Filesystem / Memory      | Binary file storage                           |
| [embedding](embedding/) | PostgreSQL + pgvector    | Vector embeddings with similarity search      |
| [position](position/)   | PostgreSQL + PostGIS     | Geo shapes (point/circle/polygon), queries    |
| [log](log/)             | PostgreSQL + TimescaleDB | Time-series logs with retention policies      |
| [null](null/)           | None                     | `/dev/null`: reads end at once, writes vanish |
| [pool](pool/)           | PostgreSQL / Memory      | Work pools claimed by capability, with leases |
| [queue](queue/)         | PostgreSQL / Memory      | Durable message queues with fanout            |
| [router](router/)       | In-memory                | Pub/sub routing with routing keys             |
| [track](track/)         | PostgreSQL + PostGIS     | GPS tracks, spatially indexed and simplified  |

## Access Modes

| Mode | Read | Write | Truncate | Append | Create |
| ---- | ---- | ----- | -------- | ------ | ------ |
| `r`  | yes  |       |          |        |        |
| `w`  |      | yes   | yes      |        | yes    |
| `a`  |      | yes   |          | yes    | yes    |
| `r+` | yes  | yes   |          |        | yes    |
| `w+` | yes  | yes   | yes      |        | yes    |
| `a+` | yes  | yes   |          | yes    | yes    |

Opening with any write/append/+ mode auto-creates the resource if it doesn't exist.

## Shared Utilities

- `ensureResource(registry, id, opts, mode)` -- handles exists/touch/truncate logic used by all `open()` implementations
- `modeFlags(mode)` -- derives `{ truncate, append }` from a mode string

## Usage Pattern

```typescript
const registry = new MemoryFileRegistry();
await registry.init();

await registry.touch('note', {});

const writer = await registry.open('note', {}, 'w');
await writer.write(new TextEncoder().encode('hello'));
await writer.close();

const reader = await registry.open('note', {}, 'r');
const data = await reader.read(1024);
await reader.close();

await registry.dispose();
```
