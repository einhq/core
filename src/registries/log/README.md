# Log Registry

Time-series log storage backed by PostgreSQL and TimescaleDB. Each log is a hypertable with configurable retention policies and routing-key based event subscription.

## Backend

PostgreSQL + TimescaleDB. Each log gets its own hypertable for efficient time-range queries and automatic data retention.

## Core Concepts

- **Retention policies**: `"30 day"`, `"forever"`, or a count such as `"1000 entries"`. Duration retention uses TimescaleDB; count retention trims after each append.
- **Routing keys**: Logs can subscribe to routing keys. When a relay event arrives matching a key, the payload is automatically appended to all subscribed logs. A key may be a wildcard pattern (`system.vfs.*.created`, `media.#`) — see `src/registries/routing-key-match.ts`.
- **Blocking reads**: When opened with an AbortSignal, `read()` blocks via LISTEN/NOTIFY until new entries arrive.
- **Cursor-based reading**: Reads track position via `lastId`, allowing sequential consumption without duplicates.

## SQL Schema

```sql
-- Registry table (one per registry)
CREATE TABLE {prefix}_logs (
  id                VARCHAR(26) PRIMARY KEY,
  retention         TEXT NOT NULL,
  routing_keys      TEXT[] NOT NULL DEFAULT '{}',
  routing_patterns  TEXT[] NOT NULL DEFAULT '{}',  -- compiled regex per wildcard binding
  created_at        TIMESTAMPTZ DEFAULT now()
);
-- GIN index on routing_keys; partial index for rows with patterns

-- Per-log hypertable
CREATE TABLE {prefix}_{logId} (
  id         BIGSERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  data       JSONB
);
-- + TimescaleDB hypertable on created_at
-- + NOTIFY trigger on insert
```

## Usage

```typescript
const registry = new PgLogRegistry({
  pool: pgPool,
  name: 'app',
  router,
});
await registry.init();

// Create a log with 30-day retention, listening to "jobs.*" events
await registry.touch('job-log', {
  retention: '30 day',
  routingKeys: ['jobs.completed', 'jobs.failed'],
});

// Append manually
const w = await registry.open('job-log', {}, 'a');
await w.write(new TextEncoder().encode(JSON.stringify({ status: 'ok' }) + '\n'));
await w.close();

// Read entries (blocking)
const r = await registry.open('job-log', {}, 'r');
const ac = new AbortController();
const data = await r.read(100, ac.signal); // blocks until entries arrive
await r.close();
```

## Configuration

| Option   | Type            | Description                                |
| -------- | --------------- | ------------------------------------------ |
| `pool`   | pg.Pool         | PostgreSQL connection pool                 |
| `name`   | string          | Prefix for table names                     |
| `router` | RouterManagerIf | Event source for routing-key subscriptions |

Ordinary reads, writes, and metadata queries acquire independent connections
from `pool`; they are not serialized across logs. Blocking readers share one
dedicated LISTEN connection, so adding followers does not consume more pool
slots.
