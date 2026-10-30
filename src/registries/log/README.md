# Log Registry

Time-series log storage backed by PostgreSQL and TimescaleDB. A log is a row in the registry's logs table; its entries live in a table it shares with every log of the same retention, so the number of tables does not grow with the number of logs. Retention, routing-key based event subscription and cursor reads are per log.

## Backend

PostgreSQL + TimescaleDB, one entry table per retention class:

| Retention   | Entry table             | Kind                                                                                                    |
| ----------- | ----------------------- | ------------------------------------------------------------------------------------------------------- |
| `forever`   | `{prefix}_e_forever`    | hypertable, 90-day chunks, compressed by log a week after a chunk closes                                |
| a duration  | `{prefix}_e_d<seconds>` | hypertable, chunks a quarter of the retention (1 hour to 90 days); compressed when kept 30 days or more |
| `N entries` | `{prefix}_e_count`      | plain table, trimmed per log after each append; never compressed                                        |

Expired data goes by TimescaleDB dropping whole chunks, one retention job per class. A chunk is dropped when all of it is older than the retention, so an entry can outlive it by up to a chunk.

## Core Concepts

- **Retention policies**: `"30 day"`, `"forever"`, or a count such as `"1000 entries"`. Changing a log's retention to another class moves its entries to that class's table.
- **Routing keys**: Logs can subscribe to routing keys. When a relay event arrives matching a key, the payload is automatically appended to all subscribed logs. A key may be a wildcard pattern (`system.vfs.*.created`, `media.#`) — see `src/registries/routing-key-match.ts`.
- **Blocking reads**: When opened with an AbortSignal, `read()` blocks until this registry next appends to the log. Appends do not `pg_notify`: a commit that notifies is not group-committed, which limits every writer at once.
- **Cursor-based reading**: Entry ids come from one sequence shared by all of the registry's logs, so they increase within each log; reads track position via `lastId`, allowing sequential consumption without duplicates.

## SQL Schema

```sql
-- Registry table (one per registry)
CREATE TABLE {prefix}_logs (
  id                VARCHAR(26) PRIMARY KEY,
  key               INTEGER GENERATED ALWAYS AS IDENTITY UNIQUE,  -- the log in the entry tables
  retention         TEXT NOT NULL,
  routing_keys      TEXT[] NOT NULL DEFAULT '{}',
  routing_patterns  TEXT[] NOT NULL DEFAULT '{}',  -- compiled regex per wildcard binding
  created_at        TIMESTAMPTZ DEFAULT now()
);
-- GIN index on routing_keys; partial index for rows with patterns
CREATE SEQUENCE {prefix}_entry_id;  -- every entry's id

-- Entry table (one per retention class)
CREATE TABLE {prefix}_e_{class} (
  log_key    INTEGER NOT NULL,
  id         BIGINT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  data       JSONB
);
-- + index on (log_key, id); hypertable on created_at without its default time index
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
from `pool`; they are not serialized across logs. Blocking readers hold no
connection while they wait. One LISTEN connection from `listenPool` follows
changes to the logs table's routing keys.
